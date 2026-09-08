import {
  DEFAULT_MAX_SCORE,
  PDF_UPLOAD_GRACE_SECONDS,
  V1_MAX_ATTEMPTS,
  isUnlimitedAttemptPath,
} from '../../database/models/conventions';
import type { UserStatus } from '../../database/models/enums';
import { remapDuplicateKey } from '../../database/errors';
import {
  attemptRepository,
  questionFileRepository,
  questionRepository,
  submissionRepository,
  testSeriesRepository,
} from '../../database/repositories/index';
import { withTransaction } from '../../database/transactions';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { accountDisabledError, AppError, ErrorCodes } from '../../shared/errors/app-error';
import {
  consumePaidEntitlementIfAttemptsExhausted,
  ensureFreeMcqEntitlement,
  studentHasTestSeriesAccess,
} from '../entitlements/entitlement.service';
import { normalizeScore } from '../evaluations/evaluation-scoring';
import { ensureEvaluationForSubmission } from '../evaluations/evaluation.service';
import { notifyAttemptSubmitted } from '../notifications/notification.service';
import { finalizeMcqOrEditorAttempt, finalizePdfAttempt } from '../submissions/submission.service';
import { isAvailabilityWindowOpen } from '../test-series/test-series.availability';
import { buildTestSeriesSummaryByIds } from '../test-series/test-series-summary';
import { assertActiveOrContinuableAttempt } from './attempt-access';
import {
  canAcceptSubmitRequest,
  computePdfUploadEndsAt,
  isPastExamEnd,
  isUploadWindowExpired,
  pdfUploadPendingFields,
  resolveAttemptType,
  shouldAutoFinalizeMcqEditor,
} from './attempt-state';
import {
  toAttemptListItemDto,
  toStudentAttemptDto,
  type StartAttemptDto,
  type StudentAttemptDto,
  type SubmitAttemptDto,
} from './attempt.dto';
import type {
  ActiveAttemptQuery,
  AttemptListQuery,
  StartAttemptInput,
  UpdateAttemptAnswersInput,
} from './attempt.validation';
import { assertOrClaimExamSession, examSessionClearFields, examSessionConflict } from './exam-session';

function attemptNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.ATTEMPT_NOT_FOUND,
    message: 'Attempt not found.',
  });
}

function testSeriesNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.TEST_SERIES_NOT_FOUND,
    message: 'Test series not found.',
  });
}

function testSeriesUnavailable(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.TEST_SERIES_UNAVAILABLE,
    message: 'Test series is not currently available.',
  });
}

function testSeriesNotStartable(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.TEST_SERIES_NOT_STARTABLE,
    message: 'Test series status does not permit starting a new attempt.',
  });
}

function attemptLimitExceeded(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.ATTEMPT_LIMIT_EXCEEDED,
    message: 'Maximum number of attempts has been reached.',
  });
}

function attemptContentInvalid(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.ATTEMPT_CONTENT_INVALID,
    message: 'Test series does not have valid content for an attempt.',
  });
}

function attemptExpired(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.ATTEMPT_EXPIRED,
    message: 'Attempt exam time has ended.',
  });
}

function attemptAlreadySubmitted(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.ATTEMPT_ALREADY_SUBMITTED,
    message: 'Attempt has already been submitted.',
  });
}

function attemptNotWritable(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.ATTEMPT_NOT_WRITABLE,
    message: 'Attempt is not writable.',
  });
}

function staleAttemptVersion(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.STALE_ATTEMPT_VERSION,
    message: 'Attempt version is stale.',
  });
}

function mapAccessDenied(reason?: string): AppError {
  if (reason === 'TEST_SERIES_NOT_FOUND') {
    return testSeriesNotFound();
  }

  if (reason === 'ENTITLEMENT_EXPIRED') {
    return new AppError({
      statusCode: 403,
      code: ErrorCodes.ENTITLEMENT_EXPIRED,
      message: 'Entitlement has expired.',
    });
  }

  return new AppError({
    statusCode: 403,
    code: ErrorCodes.ENTITLEMENT_REQUIRED,
    message: 'An active entitlement is required.',
  });
}

function asContentRecord(content: unknown): Record<string, unknown> {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return {};
  }

  return { ...(content as Record<string, unknown>) };
}

function buildQuestionSnapshot(
  questions: Array<{
    _id: { toString(): string };
    type: 'MCQ' | 'PDF' | 'EDITOR';
    position: number;
    questionText?: string;
    content?: unknown;
    marks?: number;
    status: string;
  }>,
) {
  return questions
    .filter((question) => question.status === 'ACTIVE')
    .map((question) => {
      const content = asContentRecord(question.content);
      const correctOptionId =
        typeof content.correctOptionId === 'string' ? content.correctOptionId : undefined;
      const {
        correctOptionId: _removed,
        correctOptionIds: _removedPlural,
        ...safeContent
      } = content;

      const questionPayload =
        question.type === 'MCQ'
          ? {
              text: question.questionText ?? '',
              options: Array.isArray(safeContent.options) ? safeContent.options : [],
            }
          : {
              text: question.questionText ?? '',
              ...safeContent,
            };

      return {
        questionId: question._id,
        order: question.position,
        type: question.type,
        question: questionPayload,
        ...(question.marks !== undefined ? { marks: question.marks } : {}),
        ...(question.type === 'MCQ' && correctOptionId
          ? { evaluationData: { correctOptionId } }
          : {}),
      };
    });
}

function buildConfigurationSnapshot(testSeries: {
  duration: number;
  type: string;
  scoring?: {
    correctMarks?: number;
    incorrectMarks?: number;
    unansweredMarks?: number;
    maxScore?: number;
  };
}) {
  const maxScore = normalizeScore(testSeries.scoring?.maxScore ?? DEFAULT_MAX_SCORE);

  return {
    duration: testSeries.duration,
    scoring: {
      maxScore,
      ...(testSeries.type === 'MCQ' && testSeries.scoring
        ? {
            correctMarks: testSeries.scoring.correctMarks,
            incorrectMarks: testSeries.scoring.incorrectMarks,
            unansweredMarks: testSeries.scoring.unansweredMarks,
          }
        : {}),
    },
    // MCQ/EDITOR 2-minute final-submit grace is computed at runtime from examEndsAt.
    submissionGraceSeconds: null,
    pdfUploadGraceSeconds: testSeries.type === 'PDF' ? PDF_UPLOAD_GRACE_SECONDS : null,
  };
}

function computeExamEndsAt(startedAt: Date, durationSeconds: number): Date {
  return new Date(startedAt.getTime() + durationSeconds * 1000);
}

async function ensureSubmissionEvaluation(submissionId: string | undefined, studentId: string) {
  if (!submissionId) {
    return;
  }

  await ensureEvaluationForSubmission(submissionId, { userId: studentId, role: 'STUDENT' });
}

async function loadOwnedAttempt(studentId: string, attemptId: string) {
  const attempt = await attemptRepository.findById(attemptId);

  if (!attempt || attempt.studentId.toString() !== studentId) {
    throw attemptNotFound();
  }

  return attempt;
}

/**
 * Reconcile deadline state without a background worker.
 * MCQ/EDITOR → auto-submit after the 2-minute server-only submit window.
 * PDF → UPLOAD_PENDING at examEndsAt.
 */
async function reconcileAttemptDeadline(
  attempt: Awaited<ReturnType<typeof attemptRepository.findById>>,
  now: Date,
) {
  if (!attempt) {
    return attempt;
  }

  if (attempt.status === 'UPLOAD_PENDING' && isUploadWindowExpired(attempt, now)) {
    const expired = await attemptRepository.updateById(attempt._id, {
      $set: { status: 'EXPIRED', ...examSessionClearFields() },
    });
    await consumePaidEntitlementIfAttemptsExhausted(attempt.entitlementId.toString());
    return expired;
  }

  if (attempt.status !== 'IN_PROGRESS' || !isPastExamEnd(attempt, now)) {
    return attempt;
  }

  const attemptType = await resolveAttemptType(attempt);

  if (attemptType === 'PDF') {
    return attemptRepository.updateById(attempt._id, {
      $set: pdfUploadPendingFields(attempt),
    });
  }

  if (!shouldAutoFinalizeMcqEditor(attempt, now)) {
    return attempt;
  }

  const result = await withTransaction(async (session) => {
    const fresh = await attemptRepository.findById(attempt._id, { session });

    if (!fresh || fresh.status !== 'IN_PROGRESS') {
      return { attempt: fresh };
    }

    if (!shouldAutoFinalizeMcqEditor(fresh, now)) {
      return { attempt: fresh };
    }

    const finalized = await finalizeMcqOrEditorAttempt(fresh, now, session);
    await consumePaidEntitlementIfAttemptsExhausted(fresh.entitlementId.toString(), session);
    return {
      attempt: finalized.attempt,
      submissionId: finalized.submissionId,
      studentId: fresh.studentId.toString(),
      testSeriesId: fresh.testSeriesId.toString(),
      submittedAt: finalized.submittedAt,
      newlySubmitted: finalized.created,
    };
  });

  if (result?.submissionId && result.studentId && result.newlySubmitted && result.submittedAt) {
    await notifyAttemptSubmitted({
      studentId: result.studentId,
      testSeriesId: result.testSeriesId,
      attemptId: result.attempt?._id?.toString() ?? attempt._id.toString(),
      submittedAt: result.submittedAt,
    });
  }

  if (result?.submissionId && result.studentId) {
    await ensureSubmissionEvaluation(result.submissionId, result.studentId);
  }

  return result?.attempt;
}

export async function startAttempt(
  studentId: string,
  input: StartAttemptInput,
  now = new Date(),
): Promise<StartAttemptDto> {
  const testSeries = await testSeriesRepository.findById(input.testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw testSeriesNotFound();
  }

  const recoverable = await attemptRepository.findRecoverableByStudentAndTestSeries(
    studentId,
    input.testSeriesId,
  );

  if (recoverable) {
    const reconciled = await reconcileAttemptDeadline(recoverable, now);

    if (reconciled && reconciled.status === 'IN_PROGRESS') {
      return { ...toStudentAttemptDto(reconciled, now), recovered: true };
    }

    if (reconciled && reconciled.status === 'UPLOAD_PENDING') {
      return { ...toStudentAttemptDto(reconciled, now), recovered: true };
    }

    // Submitted/expired recoverable path: fall through to create a new attempt if eligible.
  }

  if (testSeries.status !== 'ACTIVE') {
    throw testSeriesNotStartable();
  }

  if (!isAvailabilityWindowOpen(testSeries.availability, now)) {
    throw testSeriesUnavailable();
  }

  const access = await studentHasTestSeriesAccess(studentId, input.testSeriesId, now);

  if (!access.hasAccess) {
    throw mapAccessDenied(access.reason);
  }

  let entitlementId = access.entitlementId ?? null;

  if (testSeries.type === 'MCQ' || testSeries.access.isFree) {
    const freeEntitlement = await ensureFreeMcqEntitlement(studentId, input.testSeriesId);
    entitlementId = freeEntitlement.id;
  }

  // Attempts are granted per entitlement, so an attempt cannot exist without one.
  if (!entitlementId) {
    throw mapAccessDenied('ENTITLEMENT_REQUIRED');
  }

  const questions = await questionRepository.findByTestSeriesId(input.testSeriesId);
  const activeQuestions = questions.filter((question) => question.status === 'ACTIVE');

  if ((testSeries.type === 'MCQ' || testSeries.type === 'EDITOR') && activeQuestions.length === 0) {
    throw attemptContentInvalid();
  }

  const existingCount = await attemptRepository.countByEntitlementId(entitlementId);
  const unlimitedAttempts = isUnlimitedAttemptPath(testSeries);

  if (!unlimitedAttempts && existingCount >= V1_MAX_ATTEMPTS) {
    throw attemptLimitExceeded();
  }

  const attemptNumber = existingCount + 1;

  if (!unlimitedAttempts && attemptNumber > V1_MAX_ATTEMPTS) {
    throw attemptLimitExceeded();
  }

  const startedAt = now;
  const configurationSnapshot = buildConfigurationSnapshot(testSeries);
  const examEndsAt = computeExamEndsAt(startedAt, configurationSnapshot.duration);
  const questionSnapshot = buildQuestionSnapshot(activeQuestions);

  // For PDF test series, snapshot the currently active question-paper file ID so that the attempt
  // remains stable even if the admin later replaces the question paper.
  const questionPaperFileId =
    testSeries.type === 'PDF'
      ? ((await questionFileRepository.findActiveByTestSeriesId(input.testSeriesId))?._id ?? null)
      : null;

  try {
    const created = await withTransaction(async (session) => {
      const concurrent = await attemptRepository.findInProgressByStudentAndTestSeries(
        studentId,
        input.testSeriesId,
        { session },
      );

      if (concurrent) {
        return { attempt: concurrent, recovered: true as const };
      }

      const countInside = await attemptRepository.countByEntitlementId(entitlementId, { session });

      if (!unlimitedAttempts && countInside >= V1_MAX_ATTEMPTS) {
        throw attemptLimitExceeded();
      }

      const nextNumber = countInside + 1;

      if (!unlimitedAttempts && nextNumber > V1_MAX_ATTEMPTS) {
        throw attemptLimitExceeded();
      }

      const attempt = await attemptRepository.create(
        {
          studentId,
          testSeriesId: input.testSeriesId,
          entitlementId,
          status: 'IN_PROGRESS',
          startedAt,
          examEndsAt,
          uploadEndsAt: testSeries.type === 'PDF' ? computePdfUploadEndsAt(examEndsAt) : null,
          submittedAt: null,
          attemptNumber: nextNumber,
          version: 1,
          lastSavedAt: null,
          questionPaperFileId,
          questionSnapshot,
          configurationSnapshot,
          answers: [],
          editorDocument: null,
        },
        { session },
      );

      return { attempt, recovered: false as const };
    });

    return { ...toStudentAttemptDto(created.attempt, now), recovered: created.recovered };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    const raced = await attemptRepository.findInProgressByStudentAndTestSeries(
      studentId,
      input.testSeriesId,
    );

    if (raced) {
      return { ...toStudentAttemptDto(raced, now), recovered: true };
    }

    remapDuplicateKey(error, attemptLimitExceeded());
  }
}

export async function listStudentAttempts(
  studentId: string,
  query: AttemptListQuery,
  pagination: PaginationInput,
) {
  const [items, total] = await Promise.all([
    attemptRepository.listByStudent(studentId, {
      testSeriesId: query.testSeriesId,
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { startedAt: -1 },
    }),
    attemptRepository.countByStudent(studentId, { testSeriesId: query.testSeriesId }),
  ]);

  const summaryById = await buildTestSeriesSummaryByIds(
    items.map((item) => item.testSeriesId.toString()),
  );

  return {
    items: items.map((item) =>
      toAttemptListItemDto(item, summaryById.get(item.testSeriesId.toString()) ?? null),
    ),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getActiveAttempt(
  studentId: string,
  query: ActiveAttemptQuery,
  accountStatus: UserStatus = 'ACTIVE',
  now = new Date(),
): Promise<StudentAttemptDto | null> {
  const attempt = await attemptRepository.findRecoverableByStudentAndTestSeries(
    studentId,
    query.testSeriesId,
  );

  if (!attempt) {
    if (accountStatus !== 'ACTIVE') {
      throw accountDisabledError();
    }

    return null;
  }

  if (attempt.studentId.toString() !== studentId) {
    throw attemptNotFound();
  }

  const reconciled = await reconcileAttemptDeadline(attempt, now);

  if (!reconciled) {
    return null;
  }

  // After reconcile: IN_PROGRESS includes MCQ/EDITOR final-submit grace;
  // UPLOAD_PENDING is the PDF upload window. Terminal statuses are not recoverable.
  if (reconciled.status === 'IN_PROGRESS' || reconciled.status === 'UPLOAD_PENDING') {
    return toStudentAttemptDto(reconciled, now);
  }

  return null;
}

/** Submitted PDF answer sheet, so a student can review their own submission. */
async function resolveSubmittedFileId(attempt: {
  _id: { toString(): string };
  status: string;
}): Promise<string | null> {
  if (attempt.status !== 'SUBMITTED') {
    return null;
  }

  const submission = await submissionRepository.findByAttemptId(attempt._id.toString());

  return submission?.answerSheetFile ? submission.answerSheetFile.toString() : null;
}

export async function getStudentAttempt(
  studentId: string,
  attemptId: string,
  accountStatus: UserStatus = 'ACTIVE',
  now = new Date(),
): Promise<StudentAttemptDto> {
  const attempt = await loadOwnedAttempt(studentId, attemptId);
  assertActiveOrContinuableAttempt(accountStatus, attempt.status);
  const reconciled = (await reconcileAttemptDeadline(attempt, now)) ?? attempt;
  const submittedFileId = await resolveSubmittedFileId(reconciled);

  return toStudentAttemptDto(reconciled, now, { submittedFileId });
}

export async function updateAttemptAnswers(
  studentId: string,
  attemptId: string,
  input: UpdateAttemptAnswersInput,
  accountStatus: UserStatus = 'ACTIVE',
  now = new Date(),
  examSessionId?: string,
): Promise<StudentAttemptDto> {
  if (!examSessionId) {
    throw examSessionConflict();
  }

  await assertOrClaimExamSession(studentId, attemptId, examSessionId, now);

  const attempt = await loadOwnedAttempt(studentId, attemptId);
  assertActiveOrContinuableAttempt(accountStatus, attempt.status);

  if (attempt.status === 'SUBMITTED' || attempt.status === 'CANCELLED') {
    throw attempt.status === 'SUBMITTED' ? attemptAlreadySubmitted() : attemptNotWritable();
  }

  if (attempt.status === 'EXPIRED' || attempt.status === 'UPLOAD_PENDING') {
    throw attemptNotWritable();
  }

  if (attempt.status === 'IN_PROGRESS' && isPastExamEnd(attempt, now)) {
    await reconcileAttemptDeadline(attempt, now);
    throw attemptExpired();
  }

  const attemptType = await resolveAttemptType(attempt);

  if (input.answers !== undefined) {
    if (attemptType !== 'MCQ') {
      throw new AppError({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Request validation failed.',
        details: { fields: { answers: 'MCQ answers are only valid for MCQ attempts.' } },
      });
    }

    const questionIds = new Set(
      (attempt.questionSnapshot ?? []).map((snapshot: { questionId: { toString(): string } }) =>
        snapshot.questionId.toString(),
      ),
    );
    const optionIdsByQuestion = new Map<string, Set<string>>();

    for (const snapshot of attempt.questionSnapshot ?? []) {
      const content = asContentRecord(snapshot.question);
      const options = Array.isArray(content.options) ? content.options : [];
      const ids = new Set<string>();

      for (const option of options) {
        if (option !== null && typeof option === 'object' && !Array.isArray(option)) {
          const entry = option as Record<string, unknown>;
          if (typeof entry.id === 'string') {
            ids.add(entry.id);
          }
        }
      }

      optionIdsByQuestion.set(snapshot.questionId.toString(), ids);
    }

    for (const answer of input.answers) {
      if (!questionIds.has(answer.questionId)) {
        throw new AppError({
          statusCode: 400,
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Request validation failed.',
          details: { fields: { questionId: 'Question is not part of this attempt.' } },
        });
      }

      const allowed = optionIdsByQuestion.get(answer.questionId);

      if (!allowed || !allowed.has(answer.selectedOptionId)) {
        throw new AppError({
          statusCode: 400,
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Request validation failed.',
          details: { fields: { selectedOptionId: 'Option is not valid for this question.' } },
        });
      }
    }

    const merged = new Map<
      string,
      { questionId: string; selectedOptionIds: string[]; updatedAt: Date }
    >();

    for (const existing of attempt.answers ?? []) {
      merged.set(existing.questionId.toString(), {
        questionId: existing.questionId.toString(),
        selectedOptionIds: existing.selectedOptionIds ?? [],
        updatedAt: existing.updatedAt,
      });
    }

    for (const answer of input.answers) {
      merged.set(answer.questionId, {
        questionId: answer.questionId,
        selectedOptionIds: [answer.selectedOptionId],
        updatedAt: now,
      });
    }

    const updated = await attemptRepository.updateIfVersion(
      attemptId,
      input.version,
      {
        studentId,
        status: 'IN_PROGRESS',
        examEndsAt: { $gt: now },
      },
      {
        answers: Array.from(merged.values()),
        lastSavedAt: now,
      },
    );

    if (!updated) {
      const fresh = await loadOwnedAttempt(studentId, attemptId);

      if (fresh.status !== 'IN_PROGRESS' || isPastExamEnd(fresh, now)) {
        throw isPastExamEnd(fresh, now) ? attemptExpired() : attemptNotWritable();
      }

      throw staleAttemptVersion();
    }

    return toStudentAttemptDto(updated, now);
  }

  if (attemptType !== 'EDITOR') {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Request validation failed.',
      details: { fields: { editorDocument: 'editorDocument is only valid for EDITOR attempts.' } },
    });
  }

  const updated = await attemptRepository.updateIfVersion(
    attemptId,
    input.version,
    {
      studentId,
      status: 'IN_PROGRESS',
      examEndsAt: { $gt: now },
    },
    {
      editorDocument: input.editorDocument,
      lastSavedAt: now,
    },
  );

  if (!updated) {
    const fresh = await loadOwnedAttempt(studentId, attemptId);

    if (fresh.status !== 'IN_PROGRESS' || isPastExamEnd(fresh, now)) {
      throw isPastExamEnd(fresh, now) ? attemptExpired() : attemptNotWritable();
    }

    throw staleAttemptVersion();
  }

  return toStudentAttemptDto(updated, now);
}

export async function submitAttempt(
  studentId: string,
  attemptId: string,
  accountStatus: UserStatus = 'ACTIVE',
  now = new Date(),
  examSessionId?: string,
): Promise<SubmitAttemptDto> {
  if (!examSessionId) {
    throw examSessionConflict();
  }

  await assertOrClaimExamSession(studentId, attemptId, examSessionId, now);

  const attempt = await loadOwnedAttempt(studentId, attemptId);
  assertActiveOrContinuableAttempt(accountStatus, attempt.status);

  if (attempt.status === 'SUBMITTED') {
    const existing = await submissionRepository.findByAttemptId(attemptId);
    const submissionId = existing?._id.toString() ?? '';
    await consumePaidEntitlementIfAttemptsExhausted(attempt.entitlementId.toString());
    await ensureSubmissionEvaluation(submissionId, studentId);

    return {
      attemptId: attempt._id.toString(),
      submissionId,
      status: 'SUBMITTED',
      submittedAt: (attempt.submittedAt ?? existing?.submittedAt ?? now).toISOString(),
    };
  }

  if (attempt.status === 'CANCELLED' || attempt.status === 'EXPIRED') {
    throw attemptNotWritable();
  }

  const attemptType = await resolveAttemptType(attempt);

  if (attemptType === 'PDF' || attempt.status === 'UPLOAD_PENDING') {
    const pdfResult = await finalizePdfAttempt(studentId, attemptId, now);
    await ensureSubmissionEvaluation(pdfResult.submissionId, studentId);
    return pdfResult;
  }

  if (attempt.status !== 'IN_PROGRESS') {
    throw attemptNotWritable();
  }

  // Before examEndsAt and through examEndsAt + 2 minutes: final submit only.
  // After the server-only window: reject; request-driven auto-submit finalizes instead.
  if (!canAcceptSubmitRequest(attempt, now)) {
    throw attemptExpired();
  }

  const result = await withTransaction(async (session) => {
    const fresh = await attemptRepository.findById(attemptId, { session });

    if (!fresh || fresh.studentId.toString() !== studentId) {
      throw attemptNotFound();
    }

    if (fresh.status === 'SUBMITTED') {
      const existing = await submissionRepository.findByAttemptId(attemptId, { session });
      await consumePaidEntitlementIfAttemptsExhausted(fresh.entitlementId.toString(), session);
      return {
        attemptId: fresh._id.toString(),
        submissionId: existing?._id.toString() ?? '',
        status: 'SUBMITTED' as const,
        submittedAt: (fresh.submittedAt ?? existing?.submittedAt ?? now).toISOString(),
        newlySubmitted: false as const,
        studentId: fresh.studentId.toString(),
        testSeriesId: fresh.testSeriesId.toString(),
        submittedAtDate: fresh.submittedAt ?? existing?.submittedAt ?? now,
      };
    }

    if (fresh.status !== 'IN_PROGRESS') {
      throw attemptNotWritable();
    }

    if (!canAcceptSubmitRequest(fresh, now)) {
      throw attemptExpired();
    }

    const finalized = await finalizeMcqOrEditorAttempt(fresh, now, session);
    await consumePaidEntitlementIfAttemptsExhausted(fresh.entitlementId.toString(), session);

    return {
      attemptId: fresh._id.toString(),
      submissionId: finalized.submissionId,
      status: 'SUBMITTED' as const,
      submittedAt: finalized.submittedAt.toISOString(),
      newlySubmitted: finalized.created,
      studentId: fresh.studentId.toString(),
      testSeriesId: fresh.testSeriesId.toString(),
      submittedAtDate: finalized.submittedAt,
    };
  });

  if (result.newlySubmitted) {
    await notifyAttemptSubmitted({
      studentId: result.studentId,
      testSeriesId: result.testSeriesId,
      attemptId: result.attemptId,
      submittedAt: result.submittedAtDate,
    });
  }

  await ensureSubmissionEvaluation(result.submissionId, studentId);
  return {
    attemptId: result.attemptId,
    submissionId: result.submissionId,
    status: result.status,
    submittedAt: result.submittedAt,
  };
}
