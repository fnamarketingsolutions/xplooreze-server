import type { AttemptStatus, TestSeriesType } from '../../database/models/enums';
import type { TestSeriesSummaryDto } from '../test-series/test-series-summary';

export type AttemptQuestionDto = {
  id: string;
  position: number;
  type: TestSeriesType;
  questionText: string;
  content: Record<string, unknown>;
  marks?: number;
};

export type AttemptAnswerDto = {
  questionId: string;
  selectedOptionId: string | null;
  updatedAt: string;
};

export type AttemptConfigurationDto = {
  duration: number;
  scoring: {
    correctMarks?: number;
    incorrectMarks?: number;
    unansweredMarks?: number;
    maxScore?: number;
  } | null;
  submissionGraceSeconds: number | null;
  pdfUploadGraceSeconds: number | null;
};

export type StudentAttemptDto = {
  id: string;
  testSeriesId: string;
  entitlementId: string | null;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  examEndsAt: string;
  uploadEndsAt: string | null;
  submittedAt: string | null;
  serverTime: string;
  remainingSeconds: number;
  version: number;
  lastSavedAt: string | null;
  currentSubmissionFileId: string | null;
  submittedFileId: string | null;
  questionPaperFileId: string | null;
  configuration: AttemptConfigurationDto;
  questions: AttemptQuestionDto[];
  answers: AttemptAnswerDto[];
  editorDocument: unknown | null;
};

/** POST /attempts response — includes whether an existing open attempt was resumed. */
export type StartAttemptDto = StudentAttemptDto & {
  recovered: boolean;
};

export type AttemptListItemDto = {
  id: string;
  testSeriesId: string;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  examEndsAt: string;
  submittedAt: string | null;
  /** Display metadata for the hub list; batched on the server to avoid client N+1. */
  testSeries: TestSeriesSummaryDto | null;
};

export type SubmitAttemptDto = {
  attemptId: string;
  submissionId: string;
  status: AttemptStatus;
  submittedAt: string;
};

type QuestionSnapshotLike = {
  questionId: { toString(): string };
  order: number;
  type: TestSeriesType;
  question: unknown;
  marks?: number;
  evaluationData?: unknown;
};

type AnswerLike = {
  questionId: { toString(): string };
  selectedOptionIds?: string[];
  updatedAt: Date;
};

type ConfigurationLike = {
  duration: number;
  scoring?: {
    correctMarks?: number;
    incorrectMarks?: number;
    unansweredMarks?: number;
    maxScore?: number;
  } | null;
  submissionGraceSeconds?: number | null;
  pdfUploadGraceSeconds?: number | null;
};

type AttemptLike = {
  _id: { toString(): string };
  testSeriesId: { toString(): string };
  entitlementId?: { toString(): string } | null;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: Date;
  examEndsAt: Date;
  uploadEndsAt?: Date | null;
  submittedAt?: Date | null;
  version: number;
  lastSavedAt?: Date | null;
  currentSubmissionFileId?: { toString(): string } | null;
  questionPaperFileId?: { toString(): string } | null;
  configurationSnapshot: ConfigurationLike;
  questionSnapshot?: QuestionSnapshotLike[];
  answers?: AnswerLike[];
  editorDocument?: unknown;
};

function asContentRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...(value as Record<string, unknown>) };
}

function toStudentQuestionFromSnapshot(snapshot: QuestionSnapshotLike): AttemptQuestionDto {
  const raw = asContentRecord(snapshot.question);
  const questionText =
    typeof raw.text === 'string'
      ? raw.text
      : typeof raw.questionText === 'string'
        ? raw.questionText
        : '';

  let content: Record<string, unknown>;

  if (snapshot.type === 'MCQ') {
    const options = Array.isArray(raw.options) ? raw.options : [];
    const safeOptions: Array<{ id: string; text: string }> = [];

    for (const option of options) {
      if (option === null || typeof option !== 'object' || Array.isArray(option)) {
        continue;
      }

      const entry = option as Record<string, unknown>;

      if (typeof entry.id === 'string' && typeof entry.text === 'string') {
        safeOptions.push({ id: entry.id, text: entry.text });
      }
    }

    content = { options: safeOptions };
  } else {
    const { correctOptionId: _correct, correctOptionIds: _corrects, ...rest } = raw;
    content = rest;
  }

  return {
    id: snapshot.questionId.toString(),
    position: snapshot.order,
    type: snapshot.type,
    questionText,
    content,
    ...(snapshot.marks !== undefined ? { marks: snapshot.marks } : {}),
  };
}

function toAnswerDto(answer: AnswerLike): AttemptAnswerDto {
  const selected = answer.selectedOptionIds?.[0] ?? null;

  return {
    questionId: answer.questionId.toString(),
    selectedOptionId: selected,
    updatedAt: answer.updatedAt.toISOString(),
  };
}

export function remainingSeconds(examEndsAt: Date, now: Date): number {
  return Math.max(0, Math.floor((examEndsAt.getTime() - now.getTime()) / 1000));
}

/**
 * `currentSubmissionFileId` is the replaceable draft; `submittedFileId` is the
 * immutable submitted answer sheet resolved from the Submission by the caller.
 */
export function toStudentAttemptDto(
  attempt: AttemptLike,
  now: Date,
  options?: { submittedFileId?: string | null },
): StudentAttemptDto {
  const exposeDraftFile =
    attempt.status === 'IN_PROGRESS' || attempt.status === 'UPLOAD_PENDING';
  const currentSubmissionFileId =
    exposeDraftFile && attempt.currentSubmissionFileId
      ? attempt.currentSubmissionFileId.toString()
      : null;

  return {
    id: attempt._id.toString(),
    testSeriesId: attempt.testSeriesId.toString(),
    entitlementId: attempt.entitlementId ? attempt.entitlementId.toString() : null,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    examEndsAt: attempt.examEndsAt.toISOString(),
    uploadEndsAt: attempt.uploadEndsAt ? attempt.uploadEndsAt.toISOString() : null,
    submittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null,
    serverTime: now.toISOString(),
    remainingSeconds: remainingSeconds(attempt.examEndsAt, now),
    version: attempt.version,
    lastSavedAt: attempt.lastSavedAt ? attempt.lastSavedAt.toISOString() : null,
    currentSubmissionFileId,
    submittedFileId: options?.submittedFileId ?? null,
    questionPaperFileId: attempt.questionPaperFileId
      ? attempt.questionPaperFileId.toString()
      : null,
    configuration: {
      duration: attempt.configurationSnapshot.duration,
      scoring: attempt.configurationSnapshot.scoring ?? null,
      submissionGraceSeconds: attempt.configurationSnapshot.submissionGraceSeconds ?? null,
      pdfUploadGraceSeconds: attempt.configurationSnapshot.pdfUploadGraceSeconds ?? null,
    },
    questions: (attempt.questionSnapshot ?? []).map(toStudentQuestionFromSnapshot),
    answers: (attempt.answers ?? []).map(toAnswerDto),
    editorDocument: attempt.editorDocument ?? null,
  };
}

export function toAttemptListItemDto(
  attempt: AttemptLike,
  testSeries: TestSeriesSummaryDto | null = null,
): AttemptListItemDto {
  return {
    id: attempt._id.toString(),
    testSeriesId: attempt.testSeriesId.toString(),
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    examEndsAt: attempt.examEndsAt.toISOString(),
    submittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null,
    testSeries,
  };
}
