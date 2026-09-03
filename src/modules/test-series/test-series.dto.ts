import type { CatalogStatus, TestSeriesType } from '../../database/models/enums';
import { DEFAULT_MAX_SCORE, resolveMaxAttempts } from '../../database/models/conventions';
import { isAvailabilityWindowOpen } from './test-series.availability';

export type TestSeriesAccessDto = {
  isFree: boolean;
  price: number;
  currency: string;
};

export type TestSeriesAvailabilityDto = {
  startsAt: string | null;
  endsAt: string | null;
};

export type TestSeriesScoringDto = {
  correctMarks: number;
  incorrectMarks: number;
  unansweredMarks: number;
};

export type AdminTestSeriesScoringDto = {
  maxScore: number;
  correctMarks?: number;
  incorrectMarks?: number;
  unansweredMarks?: number;
};

export type TestSeriesDto = {
  id: string;
  moduleId: string;
  title: string;
  description: string;
  type: TestSeriesType;
  evaluationMode: 'AUTOMATIC' | 'MANUAL';
  duration: number;
  access: TestSeriesAccessDto;
  availability: TestSeriesAvailabilityDto;
  isAvailable: boolean;
  attemptPolicy: {
    maxAttempts: number | null;
  };
  scoring?: TestSeriesScoringDto;
  status: CatalogStatus;
};

export type AdminTestSeriesDto = Omit<TestSeriesDto, 'scoring'> & {
  scoring: AdminTestSeriesScoringDto;
  createdAt: string;
  updatedAt: string;
};

type TestSeriesLike = {
  _id: { toString(): string };
  moduleId: { toString(): string };
  title: string;
  description?: string;
  type: TestSeriesType;
  duration: number;
  access: {
    isFree: boolean;
    price: number;
    currency: string;
  };
  availability?: {
    startsAt?: Date | null;
    endsAt?: Date | null;
  };
  attemptPolicy?: {
    maxAttempts?: number | null;
  };
  scoring?: {
    correctMarks?: number;
    incorrectMarks?: number;
    unansweredMarks?: number;
    maxScore?: number;
  };
  status: CatalogStatus;
  createdAt: Date;
  updatedAt: Date;
};

function evaluationModeFor(type: TestSeriesType): 'AUTOMATIC' | 'MANUAL' {
  return type === 'MCQ' ? 'AUTOMATIC' : 'MANUAL';
}

function toAvailabilityDto(
  availability: TestSeriesLike['availability'],
): TestSeriesAvailabilityDto {
  return {
    startsAt: availability?.startsAt ? availability.startsAt.toISOString() : null,
    endsAt: availability?.endsAt ? availability.endsAt.toISOString() : null,
  };
}

function toScoringDto(scoring: TestSeriesLike['scoring']): TestSeriesScoringDto | undefined {
  if (
    scoring == null ||
    scoring.correctMarks == null ||
    scoring.incorrectMarks == null ||
    scoring.unansweredMarks == null
  ) {
    return undefined;
  }

  return {
    correctMarks: scoring.correctMarks,
    incorrectMarks: scoring.incorrectMarks,
    unansweredMarks: scoring.unansweredMarks,
  };
}

function toAdminScoringDto(testSeries: TestSeriesLike): AdminTestSeriesScoringDto {
  const maxScore = testSeries.scoring?.maxScore ?? DEFAULT_MAX_SCORE;
  const mcqMarks = toScoringDto(testSeries.scoring);

  if (testSeries.type === 'MCQ' && mcqMarks) {
    return {
      ...mcqMarks,
      maxScore,
    };
  }

  return { maxScore };
}

export function toTestSeriesDto(testSeries: TestSeriesLike, now = new Date()): TestSeriesDto {
  const availability = {
    startsAt: testSeries.availability?.startsAt ?? null,
    endsAt: testSeries.availability?.endsAt ?? null,
  };

  return {
    id: testSeries._id.toString(),
    moduleId: testSeries.moduleId.toString(),
    title: testSeries.title,
    description: testSeries.description ?? '',
    type: testSeries.type,
    evaluationMode: evaluationModeFor(testSeries.type),
    duration: testSeries.duration,
    access: {
      isFree: testSeries.access.isFree,
      price: testSeries.access.price,
      currency: testSeries.access.currency,
    },
    availability: toAvailabilityDto(testSeries.availability),
    isAvailable: isAvailabilityWindowOpen(availability, now),
    attemptPolicy: {
      maxAttempts: resolveMaxAttempts(testSeries),
    },
    ...(testSeries.type === 'MCQ' ? { scoring: toScoringDto(testSeries.scoring) } : {}),
    status: testSeries.status,
  };
}

export function toAdminTestSeriesDto(
  testSeries: TestSeriesLike,
  now = new Date(),
): AdminTestSeriesDto {
  return {
    ...toTestSeriesDto(testSeries, now),
    scoring: toAdminScoringDto(testSeries),
    createdAt: testSeries.createdAt.toISOString(),
    updatedAt: testSeries.updatedAt.toISOString(),
  };
}
