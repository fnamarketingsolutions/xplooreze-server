import { Types, type ClientSession } from 'mongoose';

import { remapDuplicateKey } from '../../database/errors';
import type { EvaluationStatus, UserRole } from '../../database/models/enums';
import { analyticsRepository } from '../../database/repositories/analytics.repository';
import {
  attemptRepository,
  auditLogRepository,
  categoryRepository,
  evaluationRepository,
  evaluationRevisionRepository,
  evaluatorCategoryAssignmentRepository,
  moduleRepository,
  submissionFileRepository,
  submissionRepository,
  testSeriesRepository,
  userRepository,
} from '../../database/repositories/index';
import { withTransaction } from '../../database/transactions';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';
import { toStudentSubmissionFileDto } from '../files/file.dto';
import { publishFromFinalizedEvaluation, type ResultPublication } from '../results/result.service';
import {
  notifyEvaluationAssigned,
  notifyResultPublished,
} from '../notifications/notification.service';
import {
  type EvaluationAttemptSummaryDto,
  type EvaluationEvaluatorSummaryDto,
  type EvaluationStudentSummaryDto,
  type EvaluationTestSeriesSummaryDto,
  toAdminEvaluationDto,
  toEvaluationListItemDto,
  toEvaluationSubmissionDto,
  toEvaluatorEvaluationDto,
} from './evaluation.dto';
import { McqScoringError, scoreMcqSubmission, snapshottedMaxScore } from './evaluation-scoring';
import type {
  AdminEvaluationListQuery,
  EvaluatorEvaluationListQuery,
  UpdateEvaluationInput,
} from './evaluation.validation';
import { buildTestSeriesSummaryByIds } from '../test-series/test-series-summary';

export type EvaluationActor = {
  userId: string;
  role: UserRole;
};

function evaluationNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.EVALUATION_NOT_FOUND,
    message: 'Evaluation not found.',
  });
}

function submissionNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.SUBMISSION_NOT_FOUND,
    message: 'Submission not found.',
  });
}

function revisionNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.REVISION_NOT_FOUND,
    message: 'Evaluation revision not found.',
  });
}

function evaluationInvalidState(
  message = 'Evaluation is not in a valid state for this operation.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.EVALUATION_INVALID_STATE,
    message,
  });
}

function evaluatorNotAuthorized(): AppError {
  return new AppError({
    statusCode: 403,
    code: ErrorCodes.EVALUATOR_NOT_AUTHORIZED,
    message: 'Evaluator is not authorized for this category.',
  });
}

function evaluatorNotAssigned(): AppError {
  return new AppError({
    statusCode: 403,
    code: ErrorCodes.EVALUATOR_NOT_ASSIGNED,
    message: 'Evaluator is not assigned to this evaluation.',
  });
}

function evaluationNotEditable(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.EVALUATION_NOT_EDITABLE,
    message: 'Evaluation can no longer be modified.',
  });
}

function evaluationAlreadyFinalized(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.EVALUATION_ALREADY_FINALIZED,
    message: 'Evaluation revision is already finalized.',
  });
}

function concurrentRevisionConflict(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.CONCURRENT_REVISION_CONFLICT,
    message: 'A concurrent evaluation update occurred. Retry the operation.',
  });
}

function invalidScore(): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.INVALID_SCORE,
    message: 'A valid non-negative score is required.',
  });
}

function invalidMaxScoreSnapshot(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.INVALID_SCORE,
    message: 'Attempt scoring snapshot is missing a valid maxScore.',
  });
}

function scoreOutOfRange(maxScore: number): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.INVALID_SCORE,
    message: `Score must be between 0 and ${maxScore}.`,
  });
}

function maxScoreFromAttempt(attempt: {
  configurationSnapshot?: { scoring?: { maxScore?: number } };
}): number {
  const maxScore = snapshottedMaxScore(attempt.configurationSnapshot?.scoring);

  if (maxScore == null) {
    throw invalidMaxScoreSnapshot();
  }

  return maxScore;
}

function assertScoreWithinMax(score: number, maxScore: number) {
  if (score < 0 || score > maxScore) {
    throw scoreOutOfRange(maxScore);
  }
}

function automaticEvaluationFailed(): AppError {
  return new AppError({
    statusCode: 500,
    code: ErrorCodes.AUTOMATIC_EVALUATION_FAILED,
    message: 'Automatic evaluation failed.',
  });
}

function invalidSubmissionType(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.INVALID_SUBMISSION_TYPE,
    message: 'Submission type cannot be evaluated.',
  });
}

async function writeAudit(
  actor: EvaluationActor,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  session?: ClientSession,
) {
  await auditLogRepository.create(
    {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action,
      resource: { type: resourceType, id: resourceId },
      metadata,
    },
    session ? { session } : undefined,
  );
}

function projectionFromRevision(revision: {
  _id: { toString(): string };
  status: EvaluationStatus;
  evaluatorId?: { toString(): string } | null;
  score?: number | null;
  maxScore?: number | null;
  remarks?: string | null;
  assignedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  finalizedAt?: Date | null;
}) {
  return {
    currentRevisionId: revision._id.toString(),
    status: revision.status,
    evaluatorId: revision.evaluatorId ? revision.evaluatorId.toString() : null,
    score: revision.score ?? null,
    maxScore: revision.maxScore ?? null,
    remarks: revision.remarks ?? null,
    assignedAt: revision.assignedAt ?? null,
    startedAt: revision.startedAt ?? null,
    completedAt: revision.completedAt ?? null,
    finalizedAt: revision.finalizedAt ?? null,
  };
}

async function loadCurrentRevision(
  evaluation: { currentRevisionId?: { toString(): string } | null },
  session?: ClientSession,
) {
  if (!evaluation.currentRevisionId) {
    throw revisionNotFound();
  }

  const revision = await evaluationRevisionRepository.findById(
    evaluation.currentRevisionId.toString(),
    {
      session,
    },
  );

  if (!revision) {
    throw revisionNotFound();
  }

  return revision;
}

async function deriveCategoryId(attempt: {
  testSeriesId: { toString(): string };
}): Promise<string> {
  const testSeries = await testSeriesRepository.findById(attempt.testSeriesId.toString());

  if (!testSeries) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCodes.TEST_SERIES_NOT_FOUND,
      message: 'Test series not found.',
    });
  }

  const module = await moduleRepository.findById(testSeries.moduleId);

  if (!module) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCodes.MODULE_NOT_FOUND,
      message: 'Module not found.',
    });
  }

  return module.categoryId.toString();
}

async function assertEvaluatorCategoryAuthorization(evaluatorId: string, categoryId: string) {
  const evaluator = await userRepository.findById(evaluatorId);

  if (
    !evaluator ||
    evaluator.deletedAt != null ||
    evaluator.role !== 'EVALUATOR' ||
    evaluator.status !== 'ACTIVE'
  ) {
    throw evaluatorNotAuthorized();
  }

  const assignment = await evaluatorCategoryAssignmentRepository.findActiveByEvaluatorAndCategory(
    evaluatorId,
    categoryId,
  );

  if (!assignment) {
    throw evaluatorNotAuthorized();
  }
}

function extractCorrectOptionId(evaluationData: unknown): string | undefined {
  if (
    evaluationData === null ||
    typeof evaluationData !== 'object' ||
    Array.isArray(evaluationData)
  ) {
    return undefined;
  }

  const correctOptionId = (evaluationData as Record<string, unknown>).correctOptionId;
  return typeof correctOptionId === 'string' ? correctOptionId : undefined;
}

function scoreMcqFromAttempt(
  attempt: {
    questionSnapshot?: Array<{
      questionId: { toString(): string };
      type?: string;
      evaluationData?: unknown;
    }>;
    configurationSnapshot?: {
      scoring?: {
        correctMarks?: number;
        incorrectMarks?: number;
        unansweredMarks?: number;
        maxScore?: number;
      };
    };
  },
  submission: {
    answers?: Array<{ questionId: { toString(): string }; selectedOptionId?: string | null }>;
  },
) {
  const scoring = attempt.configurationSnapshot?.scoring;

  if (
    scoring?.correctMarks === undefined ||
    scoring.incorrectMarks === undefined ||
    scoring.unansweredMarks === undefined
  ) {
    throw new McqScoringError('Attempt scoring snapshot is missing.');
  }

  const questions = (attempt.questionSnapshot ?? [])
    .filter((question) => question.type === 'MCQ')
    .map((question) => ({
      questionId: question.questionId.toString(),
      correctOptionId: extractCorrectOptionId(question.evaluationData),
    }));

  return scoreMcqSubmission(
    questions,
    (submission.answers ?? []).map((answer) => ({
      questionId: answer.questionId.toString(),
      selectedOptionId: answer.selectedOptionId ?? null,
    })),
    {
      correctMarks: scoring.correctMarks,
      incorrectMarks: scoring.incorrectMarks,
      unansweredMarks: scoring.unansweredMarks,
    },
  );
}

async function loadSubmissionGraph(submissionId: string, session?: ClientSession) {
  const submission = await submissionRepository.findById(
    submissionId,
    session ? { session } : undefined,
  );

  if (!submission) {
    throw submissionNotFound();
  }

  const attempt = await attemptRepository.findById(
    submission.attemptId,
    session ? { session } : undefined,
  );

  if (!attempt) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCodes.ATTEMPT_NOT_FOUND,
      message: 'Attempt not found.',
    });
  }

  return { submission, attempt };
}

async function buildSubmissionDto(
  submission: Awaited<ReturnType<typeof submissionRepository.findById>>,
  options?: { includeEditorDocument?: boolean },
) {
  if (!submission) {
    throw submissionNotFound();
  }

  let fileDto = null;

  if (submission.type === 'PDF' && submission.answerSheetFile) {
    const file = await submissionFileRepository.findById(submission.answerSheetFile);
    if (file) {
      fileDto = toStudentSubmissionFileDto(file);
    }
  }

  return toEvaluationSubmissionDto(submission, fileDto, options);
}

type UserLike = NonNullable<Awaited<ReturnType<typeof userRepository.findById>>>;

function deriveDisplayName(user: UserLike): string {
  const first = user.name?.first?.trim() ?? '';
  const last = user.name?.last?.trim() ?? '';
  return [first, last].filter(Boolean).join(' ').trim() || user.email;
}

function buildEvaluationStudentSummary(
  student: UserLike | null,
): EvaluationStudentSummaryDto | null {
  if (!student) {
    return null;
  }

  return {
    id: student._id.toString(),
    email: student.email,
    name: {
      first: student.name.first,
      last: student.name.last,
    },
    displayName: deriveDisplayName(student),
  };
}

function buildEvaluationEvaluatorSummary(
  evaluator: UserLike | null,
): EvaluationEvaluatorSummaryDto | null {
  if (!evaluator) {
    return null;
  }

  return {
    id: evaluator._id.toString(),
    email: evaluator.email,
    displayName: deriveDisplayName(evaluator),
  };
}

function buildEvaluationAttemptSummary(
  attempt: Awaited<ReturnType<typeof attemptRepository.findById>> | null,
): EvaluationAttemptSummaryDto | null {
  if (!attempt) {
    return null;
  }

  return {
    id: attempt._id.toString(),
    attemptNumber: attempt.attemptNumber,
  };
}

async function buildEvaluationContext(
  submission: Awaited<ReturnType<typeof submissionRepository.findById>>,
  attempt: Awaited<ReturnType<typeof attemptRepository.findById>>,
  evaluatorId?: { toString(): string } | null,
): Promise<{
  submissionType: Awaited<ReturnType<typeof submissionRepository.findById>>['type'] | null;
  evaluator: EvaluationEvaluatorSummaryDto | null;
  student: EvaluationStudentSummaryDto | null;
  testSeries: EvaluationTestSeriesSummaryDto | null;
  attempt: EvaluationAttemptSummaryDto | null;
}> {
  if (!submission || !attempt) {
    return {
      submissionType: submission?.type ?? null,
      evaluator: null,
      student: null,
      testSeries: null,
      attempt: null,
    };
  }

  const [student, evaluator, testSeriesById] = await Promise.all([
    userRepository.findById(submission.studentId),
    evaluatorId ? userRepository.findById(evaluatorId.toString()) : Promise.resolve(null),
    buildTestSeriesSummaryByIds([attempt.testSeriesId.toString()]),
  ]);

  return {
    submissionType: submission.type,
    evaluator: buildEvaluationEvaluatorSummary(evaluator),
    student: buildEvaluationStudentSummary(student),
    testSeries: testSeriesById.get(attempt.testSeriesId.toString()) ?? null,
    attempt: buildEvaluationAttemptSummary(attempt),
  };
}

async function notifyPublishedResult(
  result:
    | {
        _id: { toString(): string };
        studentId: { toString(): string };
        testSeriesId: { toString(): string };
        score: number;
        maxScore: number;
        percentage: number;
      }
    | null
    | undefined,
): Promise<void> {
  if (!result) {
    return;
  }

  await notifyResultPublished({
    studentId: result.studentId.toString(),
    testSeriesId: result.testSeriesId.toString(),
    resultId: result._id.toString(),
    score: result.score,
    maxScore: result.maxScore,
    percentage: result.percentage,
  });
}

async function createLogicalEvaluation(input: {
  submissionId: string;
  mode: 'AUTOMATIC' | 'MANUAL';
  revision: Record<string, unknown>;
  actor: EvaluationActor;
  auditActions: Array<{ action: string; metadata?: Record<string, unknown> }>;
}): Promise<{
  evaluation: NonNullable<Awaited<ReturnType<typeof evaluationRepository.findById>>>;
  revision: NonNullable<Awaited<ReturnType<typeof evaluationRevisionRepository.findById>>>;
  created: boolean;
}> {
  const evaluationId = new Types.ObjectId();
  const revisionId = new Types.ObjectId();

  try {
    const created = await withTransaction(async (session) => {
      const revision = await evaluationRevisionRepository.create(
        {
          _id: revisionId,
          evaluationId,
          revisionNumber: 1,
          ...input.revision,
        },
        { session },
      );

      const evaluation = await evaluationRepository.create(
        {
          _id: evaluationId,
          submissionId: input.submissionId,
          mode: input.mode,
          ...projectionFromRevision(revision),
        },
        { session },
      );

      for (const audit of input.auditActions) {
        await writeAudit(
          input.actor,
          audit.action,
          'Evaluation',
          evaluation._id.toString(),
          {
            submissionId: input.submissionId,
            mode: input.mode,
            revisionId: revision._id.toString(),
            revisionNumber: 1,
            ...audit.metadata,
          },
          session,
        );
      }

      let publication: ResultPublication = 'UNCHANGED';
      let publishedResult: Awaited<ReturnType<typeof publishFromFinalizedEvaluation>>['result'] =
        null;

      if (revision.status === 'FINALIZED') {
        const published = await publishFromFinalizedEvaluation(
          evaluation._id.toString(),
          input.actor,
          session,
        );
        publication = published.publication;
        publishedResult = published.result;
      }

      return { evaluation, revision, created: true as const, publication, publishedResult };
    });

    if (created.publication === 'PUBLISHED') {
      await notifyPublishedResult(created.publishedResult);
    }

    return created;
  } catch (error) {
    const existing = await evaluationRepository.findBySubmissionId(input.submissionId);

    if (existing) {
      const revision = await loadCurrentRevision(existing);
      return { evaluation: existing, revision, created: false };
    }

    remapDuplicateKey(
      error,
      new AppError({
        statusCode: 409,
        code: ErrorCodes.EVALUATION_ALREADY_EXISTS,
        message: 'Evaluation already exists for this submission.',
      }),
    );
  }
}

export async function ensureEvaluationForSubmission(submissionId: string, actor: EvaluationActor) {
  if (!submissionId) {
    return null;
  }

  const existing = await evaluationRepository.findBySubmissionId(submissionId);

  if (existing) {
    if (existing.status === 'FINALIZED') {
      await publishFromFinalizedEvaluation(existing._id.toString(), actor);
    }

    return existing;
  }

  const { submission, attempt } = await loadSubmissionGraph(submissionId);

  if (submission.type === 'MCQ') {
    await writeAudit(actor, 'AUTOMATIC_EVALUATION_STARTED', 'Submission', submissionId, {});

    try {
      const scored = scoreMcqFromAttempt(attempt, submission);
      const now = new Date();
      const created = await createLogicalEvaluation({
        submissionId,
        mode: 'AUTOMATIC',
        actor,
        auditActions: [
          { action: 'EVALUATION_CREATED' },
          {
            action: 'AUTOMATIC_EVALUATION_COMPLETED',
            metadata: {
              score: scored.score,
              maxScore: scored.maxScore,
              metrics: scored.metrics,
            },
          },
          { action: 'EVALUATION_FINALIZED', metadata: { score: scored.score } },
        ],
        revision: {
          status: 'FINALIZED',
          score: scored.score,
          maxScore: scored.maxScore,
          scoringSnapshot: scored.scoringSnapshot,
          metrics: scored.metrics,
          completedAt: now,
          finalizedAt: now,
        },
      });

      if (!created.created && created.revision.status === 'FINALIZED') {
        await publishFromFinalizedEvaluation(created.evaluation._id.toString(), actor);
      }

      return created.evaluation;
    } catch (error) {
      getLogger({ module: 'evaluations', event: 'AUTOMATIC_EVALUATION_FAILED' }).error(
        { submissionId, err: error instanceof Error ? error.name : 'unknown' },
        'Automatic MCQ evaluation failed',
      );

      await writeAudit(actor, 'AUTOMATIC_EVALUATION_FAILED', 'Submission', submissionId, {
        reason: error instanceof McqScoringError ? error.message : 'Automatic evaluation failed.',
      });

      if (error instanceof AppError) {
        throw error;
      }

      throw automaticEvaluationFailed();
    }
  }

  if (submission.type !== 'PDF' && submission.type !== 'EDITOR') {
    throw invalidSubmissionType();
  }

  const created = await createLogicalEvaluation({
    submissionId,
    mode: 'MANUAL',
    actor,
    auditActions: [{ action: 'EVALUATION_CREATED' }],
    revision: {
      status: 'UNASSIGNED',
      maxScore: maxScoreFromAttempt(attempt),
    },
  });

  return created.evaluation;
}

async function requireEvaluation(evaluationId: string, session?: ClientSession) {
  const evaluation = await evaluationRepository.findById(
    evaluationId,
    session ? { session } : undefined,
  );

  if (!evaluation) {
    throw evaluationNotFound();
  }

  return evaluation;
}

async function requireAssignedEvaluatorAccess(evaluatorId: string, evaluationId: string) {
  const evaluation = await requireEvaluation(evaluationId);

  if (evaluation.mode !== 'MANUAL') {
    throw evaluatorNotAssigned();
  }

  const revision = await loadCurrentRevision(evaluation);
  const { submission, attempt } = await loadSubmissionGraph(evaluation.submissionId.toString());
  const categoryId = await deriveCategoryId(attempt);
  await assertEvaluatorCategoryAuthorization(evaluatorId, categoryId);

  if (!revision.evaluatorId || revision.evaluatorId.toString() !== evaluatorId) {
    throw evaluatorNotAssigned();
  }

  return { evaluation, revision, submission, attempt, categoryId };
}

/**
 * Resource-level authorization for submission-file download.
 * Category membership alone is insufficient; the evaluator must be assigned
 * to the Evaluation for this submission.
 */
export async function assertAssignedEvaluatorForSubmission(
  evaluatorId: string,
  submissionId: string,
): Promise<void> {
  const evaluation = await evaluationRepository.findBySubmissionId(submissionId);

  if (!evaluation) {
    throw evaluatorNotAssigned();
  }

  await requireAssignedEvaluatorAccess(evaluatorId, evaluation._id.toString());
}

const SUMMARY_WINDOW_DAYS = 30;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function listEvaluatorCategories(evaluatorId: string) {
  const assignments = await evaluatorCategoryAssignmentRepository.list({
    evaluatorId,
    isActive: true,
  });
  const categoryIds = assignments.map((assignment) => assignment.categoryId.toString());
  const categories = await categoryRepository.findByIds(categoryIds);
  const categoryById = new Map(
    categories.map((category) => [category._id.toString(), category] as const),
  );

  return categoryIds.map((categoryId) => {
    const category = categoryById.get(categoryId);
    return {
      categoryId,
      name: category?.name ?? null,
      status: category?.status ?? null,
    };
  });
}

export async function getEvaluatorSummary(evaluatorId: string) {
  const until = addUtcDays(startOfUtcDay(new Date()), 1);
  const since = addUtcDays(until, -SUMMARY_WINDOW_DAYS);

  const [statusCounts, totalAssigned, completionRows, categories] = await Promise.all([
    analyticsRepository.groupEvaluationsByStatusForEvaluator(evaluatorId),
    analyticsRepository.countEvaluationsForEvaluator(evaluatorId),
    analyticsRepository.evaluatorCompletionsOverTime(evaluatorId, since, until),
    listEvaluatorCategories(evaluatorId),
  ]);

  const countByBucket = new Map(completionRows.map((row) => [row.bucket, row.count] as const));
  const buckets = Array.from({ length: SUMMARY_WINDOW_DAYS }, (_, index) => {
    const bucket = addUtcDays(since, index).toISOString().slice(0, 10);
    return { bucket, count: countByBucket.get(bucket) ?? 0 };
  });

  return {
    totalAssigned,
    statusCounts,
    categories,
    completionTrend: {
      windowDays: SUMMARY_WINDOW_DAYS,
      since: since.toISOString(),
      until: until.toISOString(),
      totalCompleted: buckets.reduce((sum, entry) => sum + entry.count, 0),
      buckets,
    },
  };
}

export async function listEvaluatorEvaluations(
  evaluatorId: string,
  query: EvaluatorEvaluationListQuery,
  pagination: PaginationInput,
) {
  const filter: Record<string, unknown> = {
    evaluatorId,
    mode: 'MANUAL',
  };

  if (query.status) {
    filter.status = query.status;
  }

  const [items, total] = await Promise.all([
    evaluationRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { updatedAt: -1 },
    }),
    evaluationRepository.count(filter),
  ]);

  const submissionGraphs = await Promise.all(
    items.map(async (item) => {
      const submission = await submissionRepository.findById(item.submissionId);
      if (!submission) {
        return [item._id.toString(), { submission: null, attempt: null }] as const;
      }

      const attempt = await attemptRepository.findById(submission.attemptId);
      return [item._id.toString(), { submission, attempt }] as const;
    }),
  );
  const graphByEvaluationId = new Map(submissionGraphs);

  const userIds = [
    ...new Set(
      [
        ...submissionGraphs.map(([, graph]) => graph.submission?.studentId?.toString()),
        ...items.map((item) => item.evaluatorId?.toString()),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const testSeriesIds = [
    ...new Set(
      submissionGraphs
        .map(([, graph]) => graph.attempt?.testSeriesId?.toString())
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const [users, testSeriesById] = await Promise.all([
    userIds.length > 0 ? userRepository.findByIds(userIds) : Promise.resolve([]),
    buildTestSeriesSummaryByIds(testSeriesIds),
  ]);
  const userById = new Map(users.map((user) => [user._id.toString(), user]));

  return {
    items: items.map((item) => {
      const graph = graphByEvaluationId.get(item._id.toString());
      const studentId = graph?.submission?.studentId?.toString();
      const testSeriesId = graph?.attempt?.testSeriesId?.toString();
      const evaluatorId = item.evaluatorId?.toString();

      return {
        ...toEvaluationListItemDto(item),
        submissionType: graph?.submission?.type ?? null,
        evaluator: evaluatorId
          ? buildEvaluationEvaluatorSummary(userById.get(evaluatorId) ?? null)
          : null,
        student: studentId ? buildEvaluationStudentSummary(userById.get(studentId) ?? null) : null,
        testSeries: testSeriesId ? testSeriesById.get(testSeriesId) ?? null : null,
        attempt: buildEvaluationAttemptSummary(graph?.attempt ?? null),
      };
    }),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getEvaluatorEvaluation(evaluatorId: string, evaluationId: string) {
  const { evaluation, revision, submission, attempt } = await requireAssignedEvaluatorAccess(
    evaluatorId,
    evaluationId,
  );

  return toEvaluatorEvaluationDto(
    evaluation,
    revision,
    await buildSubmissionDto(submission, { includeEditorDocument: submission.type === 'EDITOR' }),
    await buildEvaluationContext(submission, attempt, evaluation.evaluatorId),
  );
}

export async function startEvaluation(evaluatorId: string, evaluationId: string) {
  const { evaluation, revision } = await requireAssignedEvaluatorAccess(evaluatorId, evaluationId);

  if (revision.status === 'IN_PROGRESS' && revision.evaluatorId?.toString() === evaluatorId) {
    return getEvaluatorEvaluation(evaluatorId, evaluationId);
  }

  if (revision.status !== 'ASSIGNED') {
    throw evaluationInvalidState();
  }

  const now = new Date();

  await withTransaction(async (session) => {
    const updatedRevision = await evaluationRevisionRepository.findOneAndUpdate(
      {
        _id: revision._id,
        status: 'ASSIGNED',
        evaluatorId,
      },
      {
        $set: {
          status: 'IN_PROGRESS',
          startedAt: now,
        },
      },
      { session },
    );

    if (!updatedRevision) {
      throw concurrentRevisionConflict();
    }

    await evaluationRepository.updateById(
      evaluation._id,
      { $set: projectionFromRevision(updatedRevision) },
      { session },
    );

    await writeAudit(
      { userId: evaluatorId, role: 'EVALUATOR' },
      'EVALUATION_STARTED',
      'Evaluation',
      evaluation._id.toString(),
      {
        revisionId: updatedRevision._id.toString(),
        revisionNumber: updatedRevision.revisionNumber,
      },
      session,
    );
  });

  return getEvaluatorEvaluation(evaluatorId, evaluationId);
}

export async function updateEvaluation(
  evaluatorId: string,
  evaluationId: string,
  input: UpdateEvaluationInput,
) {
  const { evaluation, revision } = await requireAssignedEvaluatorAccess(evaluatorId, evaluationId);

  if (revision.status === 'COMPLETED') {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.EVALUATION_ALREADY_COMPLETED,
      message: 'Completed evaluation can no longer be modified.',
    });
  }

  if (revision.status === 'FINALIZED') {
    throw evaluationAlreadyFinalized();
  }

  if (revision.status !== 'IN_PROGRESS') {
    throw evaluationNotEditable();
  }

  const { attempt } = await loadSubmissionGraph(evaluation.submissionId);
  const maxScore = maxScoreFromAttempt(attempt);

  if (input.score !== undefined) {
    assertScoreWithinMax(input.score, maxScore);
  }

  await withTransaction(async (session) => {
    const updatedRevision = await evaluationRevisionRepository.findOneAndUpdate(
      {
        _id: revision._id,
        status: 'IN_PROGRESS',
        evaluatorId,
      },
      {
        $set: {
          maxScore,
          ...(input.score !== undefined ? { score: input.score } : {}),
          ...(input.remarks !== undefined ? { remarks: input.remarks } : {}),
        },
      },
      { session },
    );

    if (!updatedRevision) {
      throw evaluationNotEditable();
    }

    await evaluationRepository.updateById(
      evaluation._id,
      { $set: projectionFromRevision(updatedRevision) },
      { session },
    );
  });

  return getEvaluatorEvaluation(evaluatorId, evaluationId);
}

export async function completeEvaluation(evaluatorId: string, evaluationId: string) {
  const { evaluation, revision } = await requireAssignedEvaluatorAccess(evaluatorId, evaluationId);

  if (revision.status === 'COMPLETED' || revision.status === 'FINALIZED') {
    if (revision.status === 'COMPLETED') {
      return getEvaluatorEvaluation(evaluatorId, evaluationId);
    }

    throw evaluationAlreadyFinalized();
  }

  if (revision.status !== 'IN_PROGRESS') {
    throw evaluationInvalidState();
  }

  if (revision.score == null || revision.score < 0) {
    throw invalidScore();
  }

  const { attempt } = await loadSubmissionGraph(evaluation.submissionId);
  const maxScore = maxScoreFromAttempt(attempt);
  assertScoreWithinMax(revision.score, maxScore);

  const now = new Date();

  await withTransaction(async (session) => {
    const updatedRevision = await evaluationRevisionRepository.findOneAndUpdate(
      {
        _id: revision._id,
        status: 'IN_PROGRESS',
        evaluatorId,
      },
      {
        $set: {
          status: 'COMPLETED',
          completedAt: now,
          evaluatorId,
          maxScore,
        },
      },
      { session },
    );

    if (!updatedRevision) {
      throw concurrentRevisionConflict();
    }

    await evaluationRepository.updateById(
      evaluation._id,
      { $set: projectionFromRevision(updatedRevision) },
      { session },
    );

    await writeAudit(
      { userId: evaluatorId, role: 'EVALUATOR' },
      'EVALUATION_COMPLETED',
      'Evaluation',
      evaluation._id.toString(),
      {
        revisionId: updatedRevision._id.toString(),
        revisionNumber: updatedRevision.revisionNumber,
        score: updatedRevision.score,
      },
      session,
    );
  });

  return getEvaluatorEvaluation(evaluatorId, evaluationId);
}

export async function listAdminEvaluations(
  query: AdminEvaluationListQuery,
  pagination: PaginationInput,
) {
  const filter: Record<string, unknown> = {};

  if (query.status) {
    filter.status = query.status;
  }

  if (query.mode) {
    filter.mode = query.mode;
  }

  const [items, total] = await Promise.all([
    evaluationRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { updatedAt: -1 },
    }),
    evaluationRepository.count(filter),
  ]);

  const submissionGraphs = await Promise.all(
    items.map(async (item) => {
      const submission = await submissionRepository.findById(item.submissionId);
      if (!submission) {
        return [item._id.toString(), { submission: null, attempt: null }] as const;
      }

      const attempt = await attemptRepository.findById(submission.attemptId);
      return [item._id.toString(), { submission, attempt }] as const;
    }),
  );
  const graphByEvaluationId = new Map(submissionGraphs);

  const userIds = [
    ...new Set(
      [
        ...submissionGraphs.map(([, graph]) => graph.submission?.studentId?.toString()),
        ...items.map((item) => item.evaluatorId?.toString()),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const testSeriesIds = [
    ...new Set(
      submissionGraphs
        .map(([, graph]) => graph.attempt?.testSeriesId?.toString())
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const [users, testSeriesById] = await Promise.all([
    userIds.length > 0 ? userRepository.findByIds(userIds) : Promise.resolve([]),
    buildTestSeriesSummaryByIds(testSeriesIds),
  ]);
  const userById = new Map(users.map((user) => [user._id.toString(), user]));

  return {
    items: items.map((item) => {
      const graph = graphByEvaluationId.get(item._id.toString());
      const studentId = graph?.submission?.studentId?.toString();
      const testSeriesId = graph?.attempt?.testSeriesId?.toString();
      const evaluatorId = item.evaluatorId?.toString();

      return {
        ...toEvaluationListItemDto(item),
        submissionType: graph?.submission?.type ?? null,
        evaluator: evaluatorId
          ? buildEvaluationEvaluatorSummary(userById.get(evaluatorId) ?? null)
          : null,
        student: studentId ? buildEvaluationStudentSummary(userById.get(studentId) ?? null) : null,
        testSeries: testSeriesId ? testSeriesById.get(testSeriesId) ?? null : null,
        attempt: buildEvaluationAttemptSummary(graph?.attempt ?? null),
      };
    }),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getAdminEvaluation(evaluationId: string) {
  const evaluation = await requireEvaluation(evaluationId);
  const revision = evaluation.currentRevisionId ? await loadCurrentRevision(evaluation) : null;
  const revisions = await evaluationRevisionRepository.listByEvaluationId(evaluation._id);
  const { submission, attempt } = await loadSubmissionGraph(evaluation.submissionId.toString());

  return toAdminEvaluationDto(
    evaluation,
    revision,
    revisions,
    await buildSubmissionDto(submission, { includeEditorDocument: submission.type === 'EDITOR' }),
    await buildEvaluationContext(submission, attempt, evaluation.evaluatorId),
  );
}

export async function assignEvaluator(
  actor: EvaluationActor,
  evaluationId: string,
  evaluatorId: string,
) {
  const evaluation = await requireEvaluation(evaluationId);

  if (evaluation.mode !== 'MANUAL') {
    throw evaluationInvalidState('Automatic evaluations cannot be assigned to an evaluator.');
  }

  const revision = await loadCurrentRevision(evaluation);

  if (revision.status === 'FINALIZED') {
    throw evaluationAlreadyFinalized();
  }

  if (revision.status === 'COMPLETED') {
    throw evaluationInvalidState(
      'Completed evaluations cannot be reassigned. Initiate re-evaluation.',
    );
  }

  if (revision.status === 'IN_PROGRESS') {
    throw evaluationInvalidState('In-progress evaluations cannot be reassigned.');
  }

  if (revision.status !== 'UNASSIGNED' && revision.status !== 'ASSIGNED') {
    throw evaluationInvalidState();
  }

  if (revision.status === 'ASSIGNED' && revision.evaluatorId?.toString() === evaluatorId) {
    return getAdminEvaluation(evaluationId);
  }

  const { attempt } = await loadSubmissionGraph(evaluation.submissionId.toString());
  const categoryId = await deriveCategoryId(attempt);
  await assertEvaluatorCategoryAuthorization(evaluatorId, categoryId);

  const now = new Date();
  const previousEvaluatorId = revision.evaluatorId?.toString() ?? null;
  const expectedStatus = revision.status;

  await withTransaction(async (session) => {
    const updatedRevision = await evaluationRevisionRepository.findOneAndUpdate(
      {
        _id: revision._id,
        status: expectedStatus,
      },
      {
        $set: {
          status: 'ASSIGNED',
          evaluatorId,
          assignedAt: now,
          startedAt: null,
          completedAt: null,
          finalizedAt: null,
        },
      },
      { session },
    );

    if (!updatedRevision) {
      throw concurrentRevisionConflict();
    }

    await evaluationRepository.updateById(
      evaluation._id,
      { $set: projectionFromRevision(updatedRevision) },
      { session },
    );

    await writeAudit(
      actor,
      previousEvaluatorId && previousEvaluatorId !== evaluatorId
        ? 'EVALUATOR_REASSIGNED'
        : 'EVALUATOR_ASSIGNED',
      'Evaluation',
      evaluation._id.toString(),
      {
        revisionId: updatedRevision._id.toString(),
        revisionNumber: updatedRevision.revisionNumber,
        evaluatorId,
        previousEvaluatorId,
        categoryId,
      },
      session,
    );
  });

  await notifyEvaluationAssigned({
    evaluatorId,
    testSeriesId: attempt.testSeriesId.toString(),
    categoryId,
    evaluationId: evaluation._id.toString(),
  });

  return getAdminEvaluation(evaluationId);
}

export async function finalizeEvaluation(actor: EvaluationActor, evaluationId: string) {
  const evaluation = await requireEvaluation(evaluationId);
  const revision = await loadCurrentRevision(evaluation);

  if (revision.status === 'FINALIZED') {
    await publishFromFinalizedEvaluation(evaluationId, actor);
    return getAdminEvaluation(evaluationId);
  }

  if (revision.status !== 'COMPLETED') {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.EVALUATION_NOT_READY,
      message: 'Evaluation must be completed before finalization.',
    });
  }

  const now = new Date();

  try {
    const published = await withTransaction(async (session) => {
      const updatedRevision = await evaluationRevisionRepository.findOneAndUpdate(
        {
          _id: revision._id,
          status: 'COMPLETED',
        },
        {
          $set: {
            status: 'FINALIZED',
            finalizedAt: now,
          },
        },
        { session },
      );

      if (!updatedRevision) {
        throw concurrentRevisionConflict();
      }

      await evaluationRepository.updateById(
        evaluation._id,
        { $set: projectionFromRevision(updatedRevision) },
        { session },
      );

      await writeAudit(
        actor,
        'EVALUATION_FINALIZED',
        'Evaluation',
        evaluation._id.toString(),
        {
          revisionId: updatedRevision._id.toString(),
          revisionNumber: updatedRevision.revisionNumber,
          score: updatedRevision.score,
        },
        session,
      );

      return publishFromFinalizedEvaluation(evaluation._id.toString(), actor, session);
    });

    if (published.publication === 'PUBLISHED') {
      await notifyPublishedResult(published.result);
    }
  } catch (error) {
    const fresh = await evaluationRepository.findById(evaluationId);
    if (fresh?.status === 'FINALIZED') {
      await publishFromFinalizedEvaluation(evaluationId, actor);
      return getAdminEvaluation(evaluationId);
    }

    if (error instanceof AppError) {
      throw error;
    }

    throw error;
  }

  return getAdminEvaluation(evaluationId);
}

export async function reopenEvaluation(actor: EvaluationActor, evaluationId: string) {
  if (actor.role !== 'ADMIN') {
    throw new AppError({
      statusCode: 403,
      code: ErrorCodes.UNAUTHORIZED_RE_EVALUATION,
      message: 'Only Admin can initiate re-evaluation.',
    });
  }

  const evaluation = await requireEvaluation(evaluationId);
  const current = await loadCurrentRevision(evaluation);

  if (current.status !== 'FINALIZED') {
    throw evaluationInvalidState('Re-evaluation can only be initiated from a finalized revision.');
  }

  const { attempt } = await loadSubmissionGraph(evaluation.submissionId);
  const maxScore = maxScoreFromAttempt(attempt);
  const latest = await evaluationRevisionRepository.findLatestByEvaluationId(evaluation._id);
  const nextNumber = (latest?.revisionNumber ?? current.revisionNumber) + 1;
  const revisionId = new Types.ObjectId();

  try {
    await withTransaction(async (session) => {
      const claimed = await evaluationRepository.findOneAndUpdate(
        {
          _id: evaluation._id,
          status: 'FINALIZED',
          currentRevisionId: current._id,
        },
        {
          $set: {
            currentRevisionId: revisionId,
            status: 'UNASSIGNED',
            evaluatorId: null,
            score: null,
            maxScore,
            remarks: null,
            assignedAt: null,
            startedAt: null,
            completedAt: null,
            finalizedAt: null,
          },
        },
        { session },
      );

      if (!claimed) {
        throw concurrentRevisionConflict();
      }

      await evaluationRevisionRepository.create(
        {
          _id: revisionId,
          evaluationId: evaluation._id,
          revisionNumber: nextNumber,
          status: 'UNASSIGNED',
          maxScore,
        },
        { session },
      );

      await writeAudit(
        actor,
        'EVALUATION_REOPENED',
        'Evaluation',
        evaluation._id.toString(),
        {
          previousRevisionId: current._id.toString(),
          previousRevisionNumber: current.revisionNumber,
          revisionId: revisionId.toString(),
          revisionNumber: nextNumber,
        },
        session,
      );
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    remapDuplicateKey(error, concurrentRevisionConflict());
  }

  return getAdminEvaluation(evaluationId);
}
