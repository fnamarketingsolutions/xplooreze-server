import type { ClientSession, Types } from 'mongoose';

import { remapDuplicateKey } from '../../database/errors';
import type { UserRole } from '../../database/models/enums';
import {
  attemptRepository,
  auditLogRepository,
  categoryRepository,
  evaluationRepository,
  evaluationRevisionRepository,
  moduleRepository,
  resultRepository,
  submissionRepository,
  testSeriesRepository,
  userRepository,
} from '../../database/repositories/index';
import type { ResultListFilter } from '../../database/repositories/exam.repository';
import { withTransaction } from '../../database/transactions';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { resolveStudentOrTestSeriesSearch } from '../admin-list-search';
import { toStudentAttemptDto } from '../attempts/attempt.dto';
import { normalizeScore } from '../evaluations/evaluation-scoring';
import { notifyResultPublished } from '../notifications/notification.service';
import {
  buildTestSeriesSummaryByIds,
  type TestSeriesSummaryDto,
} from '../test-series/test-series-summary';
import {
  toAdminResultDto,
  toResultAttemptSummary,
  toResultCatalogSummary,
  toResultEvaluationSummary,
  toResultUserSummary,
  toStudentResultDto,
  type ResultCatalogSummary,
  type StudentResultDetailDto,
} from './result.dto';
import type { AdminResultListQuery } from './result.validation';

export type ResultActor = {
  userId: string;
  role: UserRole;
};

type ScoreSnapshot = {
  score: number;
  maxScore: number;
  percentage: number;
};

function resultNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.RESULT_NOT_FOUND,
    message: 'Result not found.',
  });
}

function evaluationNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.EVALUATION_NOT_FOUND,
    message: 'Evaluation not found.',
  });
}

function revisionNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.REVISION_NOT_FOUND,
    message: 'Evaluation revision not found.',
  });
}

function attemptNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.ATTEMPT_NOT_FOUND,
    message: 'Attempt not found.',
  });
}

function submissionNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.SUBMISSION_NOT_FOUND,
    message: 'Submission not found.',
  });
}

async function writeAudit(
  actor: ResultActor,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  session?: ClientSession,
) {
  await auditLogRepository.create(
    {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action,
      resource: { type: 'Result', id: resourceId },
      metadata,
    },
    session ? { session } : undefined,
  );
}

export function snapshotResultScores(score: number, maxScore: number): ScoreSnapshot {
  if (!Number.isFinite(maxScore) || maxScore <= 0) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.INVALID_SCORE,
      message: 'Finalized evaluation is missing a valid maxScore.',
    });
  }

  const normalizedScore = normalizeScore(score);
  const normalizedMaxScore = normalizeScore(maxScore);
  const percentage = normalizeScore((normalizedScore / normalizedMaxScore) * 100);

  return {
    score: normalizedScore,
    maxScore: normalizedMaxScore,
    percentage,
  };
}

export type ResultPublication = 'PUBLISHED' | 'UPDATED' | 'UNCHANGED';

export type PublishResultOutcome = {
  result: Awaited<ReturnType<typeof resultRepository.findByAttemptId>>;
  publication: ResultPublication;
};

function unpublishedOutcome(result: PublishResultOutcome['result'] = null): PublishResultOutcome {
  return { result, publication: 'UNCHANGED' };
}

async function notifyIfFirstPublication(outcome: PublishResultOutcome): Promise<void> {
  if (outcome.publication !== 'PUBLISHED' || !outcome.result) {
    return;
  }

  await notifyResultPublished({
    studentId: outcome.result.studentId.toString(),
    testSeriesId: outcome.result.testSeriesId.toString(),
    resultId: outcome.result._id.toString(),
    score: outcome.result.score,
    maxScore: outcome.result.maxScore,
    percentage: outcome.result.percentage,
  });
}

function samePublishedOutcome(
  result: { status: string; score: number; maxScore: number; percentage: number },
  snapshot: ScoreSnapshot,
): boolean {
  return (
    result.status === 'PUBLISHED' &&
    result.score === snapshot.score &&
    result.maxScore === snapshot.maxScore &&
    result.percentage === snapshot.percentage
  );
}

async function publishFromFinalizedEvaluationInSession(
  evaluationId: string,
  actor: ResultActor,
  session: ClientSession,
): Promise<PublishResultOutcome> {
  const evaluation = await evaluationRepository.findById(evaluationId, { session });

  if (!evaluation) {
    throw evaluationNotFound();
  }

  if (!evaluation.currentRevisionId) {
    throw revisionNotFound();
  }

  const revision = await evaluationRevisionRepository.findById(evaluation.currentRevisionId, {
    session,
  });

  if (!revision) {
    throw revisionNotFound();
  }

  if (revision.status !== 'FINALIZED') {
    const submission = await submissionRepository.findById(evaluation.submissionId, { session });
    if (!submission) {
      return unpublishedOutcome();
    }

    return unpublishedOutcome(
      await resultRepository.findByAttemptId(submission.attemptId, { session }),
    );
  }

  if (revision.score == null || !Number.isFinite(revision.score)) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.INVALID_SCORE,
      message: 'Finalized evaluation is missing a score.',
    });
  }

  if (revision.maxScore == null || !Number.isFinite(revision.maxScore) || revision.maxScore <= 0) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.INVALID_SCORE,
      message: 'Finalized evaluation is missing a valid maxScore.',
    });
  }

  const submission = await submissionRepository.findById(evaluation.submissionId, { session });

  if (!submission) {
    throw submissionNotFound();
  }

  const attempt = await attemptRepository.findById(submission.attemptId, { session });

  if (!attempt) {
    throw attemptNotFound();
  }

  const snapshot = snapshotResultScores(revision.score, revision.maxScore);
  const existing = await resultRepository.findByAttemptId(attempt._id, { session });

  if (existing && samePublishedOutcome(existing, snapshot)) {
    return { result: existing, publication: 'UNCHANGED' };
  }

  const now = new Date();

  try {
    const upserted = await resultRepository.upsertByAttemptId(
      attempt._id,
      {
        studentId: attempt.studentId,
        testSeriesId: attempt.testSeriesId,
        publishedAt: now,
      },
      {
        submissionId: submission._id,
        evaluationId: evaluation._id,
        score: snapshot.score,
        maxScore: snapshot.maxScore,
        percentage: snapshot.percentage,
        status: 'PUBLISHED',
      },
      { session },
    );

    if (!upserted.document) {
      throw new AppError({
        statusCode: 500,
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Result could not be persisted.',
      });
    }

    const metadata = {
      attemptId: attempt._id.toString(),
      evaluationId: evaluation._id.toString(),
      revisionId: revision._id.toString(),
      revisionNumber: revision.revisionNumber,
      score: snapshot.score,
      maxScore: snapshot.maxScore,
      percentage: snapshot.percentage,
    };

    if (upserted.upserted) {
      await writeAudit(
        actor,
        'RESULT_CREATED',
        upserted.document._id.toString(),
        metadata,
        session,
      );
      await writeAudit(
        actor,
        'RESULT_PUBLISHED',
        upserted.document._id.toString(),
        metadata,
        session,
      );
      return { result: upserted.document, publication: 'PUBLISHED' };
    }

    if (!existing) {
      return { result: upserted.document, publication: 'UNCHANGED' };
    }

    if (existing.status !== 'PUBLISHED') {
      await writeAudit(
        actor,
        'RESULT_PUBLISHED',
        upserted.document._id.toString(),
        metadata,
        session,
      );
      return { result: upserted.document, publication: 'PUBLISHED' };
    }

    await writeAudit(
      actor,
      'RESULT_UPDATED_AFTER_RE_EVALUATION',
      upserted.document._id.toString(),
      {
        ...metadata,
        previousScore: existing.score,
        previousMaxScore: existing.maxScore,
      },
      session,
    );

    return { result: upserted.document, publication: 'UPDATED' };
  } catch (error) {
    const raced = await resultRepository.findByAttemptId(attempt._id, { session });

    if (raced && samePublishedOutcome(raced, snapshot)) {
      return { result: raced, publication: 'UNCHANGED' };
    }

    remapDuplicateKey(
      error,
      new AppError({
        statusCode: 409,
        code: ErrorCodes.DUPLICATE_KEY,
        message: 'A result already exists for this attempt.',
      }),
    );
  }

  return unpublishedOutcome();
}

/**
 * Generate or update the Attempt's Result from the current Evaluation Revision
 * only when that revision is FINALIZED. A non-finalized current revision is a
 * no-op so an unfinished re-evaluation cannot replace a published Result.
 */
export async function publishFromFinalizedEvaluation(
  evaluationId: string,
  actor: ResultActor,
  session?: ClientSession,
): Promise<PublishResultOutcome> {
  if (session) {
    return publishFromFinalizedEvaluationInSession(evaluationId, actor, session);
  }

  const outcome: PublishResultOutcome = await withTransaction((activeSession) =>
    publishFromFinalizedEvaluationInSession(evaluationId, actor, activeSession),
  );
  await notifyIfFirstPublication(outcome);
  return outcome;
}

export async function listStudentResults(studentId: string, pagination: PaginationInput) {
  const filter = { studentId, status: 'PUBLISHED' as const };
  const [items, total] = await Promise.all([
    resultRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { publishedAt: -1, createdAt: -1 },
    }),
    resultRepository.count(filter),
  ]);

  const summaryById = await buildTestSeriesSummaryByIds(
    items.map((item) => item.testSeriesId.toString()),
  );

  return {
    items: items.map((item) =>
      toStudentResultDto(item, summaryById.get(item.testSeriesId.toString()) ?? null),
    ),
    pagination: toPaginationMeta(pagination, total),
  };
}

function testSeriesSummaryFromCatalog(
  catalog: ResultCatalogSummary | null,
): TestSeriesSummaryDto | null {
  if (!catalog) {
    return null;
  }

  return {
    id: catalog.testSeries.id,
    title: catalog.testSeries.title,
    type: catalog.testSeries.type,
    moduleName: catalog.module?.name ?? null,
    categoryId: catalog.category?.id ?? null,
    categoryName: catalog.category?.name ?? null,
  };
}

export async function getStudentResult(
  studentId: string,
  resultId: string,
  now = new Date(),
): Promise<StudentResultDetailDto> {
  const result = await resultRepository.findById(resultId);

  if (!result || result.studentId.toString() !== studentId || result.status !== 'PUBLISHED') {
    throw resultNotFound();
  }

  const [catalog, attempt, submission] = await Promise.all([
    resolveResultCatalog(result.testSeriesId),
    attemptRepository.findById(result.attemptId),
    submissionRepository.findById(result.submissionId),
  ]);

  const ownedAttempt =
    attempt && attempt.studentId.toString() === studentId ? attempt : null;
  const submittedFileId =
    ownedAttempt?.status === 'SUBMITTED' && submission?.answerSheetFile
      ? submission.answerSheetFile.toString()
      : null;

  return {
    ...toStudentResultDto(result, testSeriesSummaryFromCatalog(catalog)),
    catalog,
    attempt: ownedAttempt
      ? toStudentAttemptDto(ownedAttempt, now, { submittedFileId })
      : null,
  };
}

export async function listAdminResults(
  pagination: PaginationInput,
  query: AdminResultListQuery = {},
) {
  let filter: ResultListFilter = {};

  if (query.search) {
    const resolved = await resolveStudentOrTestSeriesSearch(query.search);
    if (resolved.kind === 'empty') {
      return {
        items: [],
        pagination: toPaginationMeta(pagination, 0),
      };
    }
    filter = { $or: resolved.$or };
  }

  const [items, total] = await Promise.all([
    resultRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { createdAt: -1 },
    }),
    resultRepository.count(filter),
  ]);

  return {
    items: items.map((item) => toAdminResultDto(item)),
    pagination: toPaginationMeta(pagination, total),
  };
}

async function resolveResultCatalog(testSeriesId: Types.ObjectId) {
  const testSeries = await testSeriesRepository.findById(testSeriesId);

  if (!testSeries) {
    return null;
  }

  const moduleDoc = await moduleRepository.findById(testSeries.moduleId);
  const category = moduleDoc ? await categoryRepository.findById(moduleDoc.categoryId) : null;

  return toResultCatalogSummary(testSeries, moduleDoc, category);
}

async function resolveResultEvaluation(evaluationId: Types.ObjectId | null | undefined) {
  if (!evaluationId) {
    return null;
  }

  const evaluation = await evaluationRepository.findById(evaluationId);

  if (!evaluation) {
    return null;
  }

  const revision = evaluation.currentRevisionId
    ? await evaluationRevisionRepository.findById(evaluation.currentRevisionId)
    : null;
  const evaluatorId = revision?.evaluatorId ?? evaluation.evaluatorId;
  const evaluator = evaluatorId ? await userRepository.findById(evaluatorId) : null;

  return toResultEvaluationSummary(evaluation, revision, evaluator);
}

/**
 * Admin single-result read, expanded with the student, catalog path, attempt,
 * and evaluation the Result points at.
 */
export async function getAdminResult(resultId: string) {
  const result = await resultRepository.findById(resultId);

  if (!result) {
    throw resultNotFound();
  }

  const [student, catalog, attempt, evaluation] = await Promise.all([
    userRepository.findById(result.studentId),
    resolveResultCatalog(result.testSeriesId),
    attemptRepository.findById(result.attemptId),
    resolveResultEvaluation(result.evaluationId),
  ]);

  return {
    ...toAdminResultDto(result),
    student: student ? toResultUserSummary(student) : null,
    catalog,
    attempt: attempt ? toResultAttemptSummary(attempt) : null,
    evaluation,
  };
}
