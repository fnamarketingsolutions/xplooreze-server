import type {
  EvaluationMode,
  EvaluationStatus,
  FileStatus,
  TestSeriesType,
} from '../../database/models/enums';

export type EvaluationRevisionDto = {
  id: string;
  revisionNumber: number;
  status: EvaluationStatus;
  evaluatorId: string | null;
  score: number | null;
  maxScore: number | null;
  remarks: string | null;
  scoringSnapshot: {
    correctMarks: number;
    incorrectMarks: number;
    unansweredMarks: number;
  } | null;
  metrics: {
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
  } | null;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationSubmissionFileDto = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: FileStatus;
};

export type EvaluationStudentSummaryDto = {
  id: string;
  email: string;
  name: {
    first: string;
    last: string;
  };
  displayName: string;
};

export type EvaluationEvaluatorSummaryDto = {
  id: string;
  email: string;
  displayName: string;
};

export type EvaluationTestSeriesSummaryDto = {
  id: string;
  title: string;
  type: TestSeriesType;
  moduleName: string | null;
  categoryId: string | null;
  categoryName: string | null;
};

export type EvaluationAttemptSummaryDto = {
  id: string;
  attemptNumber: number;
};

export type EvaluationSubmissionDto = {
  id: string;
  attemptId: string;
  studentId: string;
  type: TestSeriesType;
  submittedAt: string;
  editorDocument?: unknown;
  answerSheetFile?: EvaluationSubmissionFileDto | null;
};

export type EvaluationListItemDto = {
  id: string;
  submissionId: string;
  mode: EvaluationMode;
  submissionType: TestSeriesType | null;
  status: EvaluationStatus;
  evaluatorId: string | null;
  score: number | null;
  maxScore: number | null;
  evaluator: EvaluationEvaluatorSummaryDto | null;
  student: EvaluationStudentSummaryDto | null;
  testSeries: EvaluationTestSeriesSummaryDto | null;
  attempt: EvaluationAttemptSummaryDto | null;
  currentRevisionId: string | null;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationDetailDto = EvaluationListItemDto & {
  remarks: string | null;
  currentRevision: EvaluationRevisionDto | null;
  submission: EvaluationSubmissionDto;
};

export type AdminEvaluationDetailDto = EvaluationDetailDto & {
  revisions: EvaluationRevisionDto[];
};

type DateLike = Date | null | undefined;

type RevisionLike = {
  _id: { toString(): string };
  revisionNumber: number;
  status: EvaluationStatus;
  evaluatorId?: { toString(): string } | null;
  score?: number | null;
  maxScore?: number | null;
  remarks?: string | null;
  scoringSnapshot?: {
    correctMarks: number;
    incorrectMarks: number;
    unansweredMarks: number;
  } | null;
  metrics?: {
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
  } | null;
  assignedAt?: DateLike;
  startedAt?: DateLike;
  completedAt?: DateLike;
  finalizedAt?: DateLike;
  createdAt: Date;
  updatedAt: Date;
};

type EvaluationLike = {
  _id: { toString(): string };
  submissionId: { toString(): string };
  mode: EvaluationMode;
  status: EvaluationStatus;
  evaluatorId?: { toString(): string } | null;
  score?: number | null;
  maxScore?: number | null;
  remarks?: string | null;
  currentRevisionId?: { toString(): string } | null;
  assignedAt?: DateLike;
  startedAt?: DateLike;
  completedAt?: DateLike;
  finalizedAt?: DateLike;
  createdAt: Date;
  updatedAt: Date;
};

type SubmissionLike = {
  _id: { toString(): string };
  attemptId: { toString(): string };
  studentId: { toString(): string };
  type: TestSeriesType;
  submittedAt: Date;
  editorDocument?: unknown;
  answerSheetFile?: { toString(): string } | null;
};

function toIso(value: DateLike): string | null {
  return value ? value.toISOString() : null;
}

export function toEvaluationRevisionDto(revision: RevisionLike): EvaluationRevisionDto {
  return {
    id: revision._id.toString(),
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    evaluatorId: revision.evaluatorId ? revision.evaluatorId.toString() : null,
    score: revision.score ?? null,
    maxScore: revision.maxScore ?? null,
    remarks: revision.remarks ?? null,
    scoringSnapshot: revision.scoringSnapshot ?? null,
    metrics: revision.metrics ?? null,
    assignedAt: toIso(revision.assignedAt),
    startedAt: toIso(revision.startedAt),
    completedAt: toIso(revision.completedAt),
    finalizedAt: toIso(revision.finalizedAt),
    createdAt: revision.createdAt.toISOString(),
    updatedAt: revision.updatedAt.toISOString(),
  };
}

export function toEvaluationListItemDto(evaluation: EvaluationLike): EvaluationListItemDto {
  return {
    id: evaluation._id.toString(),
    submissionId: evaluation.submissionId.toString(),
    mode: evaluation.mode,
    submissionType: null,
    status: evaluation.status,
    evaluatorId: evaluation.evaluatorId ? evaluation.evaluatorId.toString() : null,
    score: evaluation.score ?? null,
    maxScore: evaluation.maxScore ?? null,
    evaluator: null,
    student: null,
    testSeries: null,
    attempt: null,
    currentRevisionId: evaluation.currentRevisionId
      ? evaluation.currentRevisionId.toString()
      : null,
    assignedAt: toIso(evaluation.assignedAt),
    startedAt: toIso(evaluation.startedAt),
    completedAt: toIso(evaluation.completedAt),
    finalizedAt: toIso(evaluation.finalizedAt),
    createdAt: evaluation.createdAt.toISOString(),
    updatedAt: evaluation.updatedAt.toISOString(),
  };
}

export function toEvaluationSubmissionDto(
  submission: SubmissionLike,
  file?: EvaluationSubmissionFileDto | null,
  options?: { includeEditorDocument?: boolean },
): EvaluationSubmissionDto {
  return {
    id: submission._id.toString(),
    attemptId: submission.attemptId.toString(),
    studentId: submission.studentId.toString(),
    type: submission.type,
    submittedAt: submission.submittedAt.toISOString(),
    ...(options?.includeEditorDocument
      ? { editorDocument: submission.editorDocument ?? null }
      : {}),
    ...(submission.type === 'PDF' ? { answerSheetFile: file ?? null } : {}),
  };
}

export function toEvaluatorEvaluationDto(
  evaluation: EvaluationLike,
  revision: RevisionLike | null,
  submission: EvaluationSubmissionDto,
  context?: {
    submissionType?: TestSeriesType | null;
    evaluator?: EvaluationEvaluatorSummaryDto | null;
    student?: EvaluationStudentSummaryDto | null;
    testSeries?: EvaluationTestSeriesSummaryDto | null;
    attempt?: EvaluationAttemptSummaryDto | null;
  },
): EvaluationDetailDto {
  return {
    ...toEvaluationListItemDto(evaluation),
    submissionType: context?.submissionType ?? submission.type ?? null,
    evaluator: context?.evaluator ?? null,
    student: context?.student ?? null,
    testSeries: context?.testSeries ?? null,
    attempt: context?.attempt ?? null,
    remarks: evaluation.remarks ?? null,
    currentRevision: revision ? toEvaluationRevisionDto(revision) : null,
    submission,
  };
}

export function toAdminEvaluationDto(
  evaluation: EvaluationLike,
  revision: RevisionLike | null,
  revisions: RevisionLike[],
  submission: EvaluationSubmissionDto,
  context?: {
    submissionType?: TestSeriesType | null;
    evaluator?: EvaluationEvaluatorSummaryDto | null;
    student?: EvaluationStudentSummaryDto | null;
    testSeries?: EvaluationTestSeriesSummaryDto | null;
    attempt?: EvaluationAttemptSummaryDto | null;
  },
): AdminEvaluationDetailDto {
  return {
    ...toEvaluatorEvaluationDto(evaluation, revision, submission, context),
    revisions: revisions.map(toEvaluationRevisionDto),
  };
}
