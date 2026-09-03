import type {
  AttemptStatus,
  CatalogStatus,
  EvaluationMode,
  EvaluationStatus,
  ResultStatus,
  TestSeriesType,
} from '../../database/models/enums';
import { resolveMaxAttempts } from '../../database/models/conventions';
import type { StudentAttemptDto } from '../attempts/attempt.dto';
import type { TestSeriesSummaryDto } from '../test-series/test-series-summary';

export type StudentResultDto = {
  id: string;
  attemptId: string;
  testSeriesId: string;
  score: number;
  maxScore: number;
  percentage: number;
  status: ResultStatus;
  publishedAt: string | null;
  /** Display metadata for list UIs; batched on the server to avoid client N+1. */
  testSeries: TestSeriesSummaryDto | null;
};

export type AdminResultDto = StudentResultDto & {
  studentId: string;
  submissionId: string;
  evaluationId: string | null;
  createdAt: string;
  updatedAt: string;
};

type DateLike = Date | null | undefined;

type ResultLike = {
  _id: { toString(): string };
  studentId: { toString(): string };
  testSeriesId: { toString(): string };
  attemptId: { toString(): string };
  submissionId: { toString(): string };
  evaluationId?: { toString(): string } | null;
  score: number;
  maxScore: number;
  percentage: number;
  status: ResultStatus;
  publishedAt?: DateLike;
  createdAt: Date;
  updatedAt: Date;
};

function toIso(value: DateLike): string | null {
  return value ? value.toISOString() : null;
}

export function toStudentResultDto(
  result: ResultLike,
  testSeries: TestSeriesSummaryDto | null = null,
): StudentResultDto {
  return {
    id: result._id.toString(),
    attemptId: result.attemptId.toString(),
    testSeriesId: result.testSeriesId.toString(),
    score: result.score,
    maxScore: result.maxScore,
    percentage: result.percentage,
    status: result.status,
    publishedAt: toIso(result.publishedAt),
    testSeries,
  };
}

export function toAdminResultDto(result: ResultLike): AdminResultDto {
  return {
    ...toStudentResultDto(result),
    studentId: result.studentId.toString(),
    submissionId: result.submissionId.toString(),
    evaluationId: result.evaluationId ? result.evaluationId.toString() : null,
    createdAt: result.createdAt.toISOString(),
    updatedAt: result.updatedAt.toISOString(),
  };
}

export type ResultUserSummary = {
  id: string;
  name: string;
  email: string;
};

export type ResultCatalogSummary = {
  testSeries: {
    id: string;
    title: string;
    type: TestSeriesType;
    status: CatalogStatus;
    maxAttempts: number | null;
    duration: number;
    evaluationMode: EvaluationMode;
  };
  module: { id: string; name: string; status: CatalogStatus } | null;
  category: { id: string; name: string; status: CatalogStatus } | null;
};

export type ResultAttemptSummary = {
  id: string;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  examEndsAt: string;
  submittedAt: string | null;
};

export type ResultEvaluationSummary = {
  id: string;
  mode: EvaluationMode;
  status: EvaluationStatus;
  revisionNumber: number | null;
  finalizedAt: string | null;
  evaluator: ResultUserSummary | null;
};

/**
 * Admin single-result read. Related documents are resolved so the Admin UI does
 * not have to fan out to catalog, attempt, and evaluation endpoints per row.
 * Any reference that no longer resolves is reported as null rather than 404.
 */
export type AdminResultDetailDto = AdminResultDto & {
  student: ResultUserSummary | null;
  catalog: ResultCatalogSummary | null;
  attempt: ResultAttemptSummary | null;
  evaluation: ResultEvaluationSummary | null;
};

/**
 * Student single-result read. Catalog path + owned Attempt are expanded so the
 * results UI does not fan out to catalog/attempt endpoints. Correct options are
 * never present on the embedded Attempt (same rules as GET /me/attempts/:id).
 */
export type StudentResultDetailDto = StudentResultDto & {
  catalog: ResultCatalogSummary | null;
  attempt: StudentAttemptDto | null;
};

type UserLike = {
  _id: { toString(): string };
  name: { first: string; last: string };
  email: string;
};

type TestSeriesLike = {
  _id: { toString(): string };
  moduleId: { toString(): string };
  title: string;
  type: TestSeriesType;
  status: CatalogStatus;
  duration: number;
  access?: { isFree?: boolean };
  attemptPolicy?: { maxAttempts?: number | null };
};

type NamedCatalogLike = {
  _id: { toString(): string };
  name: string;
  status: CatalogStatus;
};

type AttemptLike = {
  _id: { toString(): string };
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: Date;
  examEndsAt: Date;
  submittedAt?: DateLike;
};

type EvaluationLike = {
  _id: { toString(): string };
  mode: EvaluationMode;
  status: EvaluationStatus;
  finalizedAt?: DateLike;
};

type RevisionLike = {
  revisionNumber: number;
  finalizedAt?: DateLike;
};

export function toResultUserSummary(user: UserLike): ResultUserSummary {
  return {
    id: user._id.toString(),
    name: `${user.name.first} ${user.name.last}`.trim(),
    email: user.email,
  };
}

export function toResultCatalogSummary(
  testSeries: TestSeriesLike,
  moduleDoc: NamedCatalogLike | null,
  category: NamedCatalogLike | null,
): ResultCatalogSummary {
  const toNamed = (doc: NamedCatalogLike) => ({
    id: doc._id.toString(),
    name: doc.name,
    status: doc.status,
  });

  return {
    testSeries: {
      id: testSeries._id.toString(),
      title: testSeries.title,
      type: testSeries.type,
      status: testSeries.status,
      maxAttempts: resolveMaxAttempts(testSeries),
      duration: testSeries.duration,
      evaluationMode: testSeries.type === 'MCQ' ? 'AUTOMATIC' : 'MANUAL',
    },
    module: moduleDoc ? toNamed(moduleDoc) : null,
    category: category ? toNamed(category) : null,
  };
}

export function toResultAttemptSummary(attempt: AttemptLike): ResultAttemptSummary {
  return {
    id: attempt._id.toString(),
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    examEndsAt: attempt.examEndsAt.toISOString(),
    submittedAt: toIso(attempt.submittedAt),
  };
}

export function toResultEvaluationSummary(
  evaluation: EvaluationLike,
  revision: RevisionLike | null,
  evaluator: UserLike | null,
): ResultEvaluationSummary {
  return {
    id: evaluation._id.toString(),
    mode: evaluation.mode,
    status: evaluation.status,
    revisionNumber: revision ? revision.revisionNumber : null,
    finalizedAt: toIso(revision?.finalizedAt ?? evaluation.finalizedAt),
    evaluator: evaluator ? toResultUserSummary(evaluator) : null,
  };
}
