import { CATALOG_STATUSES, TEST_SERIES_TYPES } from '../../database/models/enums';
import type { CatalogStatus, TestSeriesType } from '../../database/models/enums';
import { DEFAULT_MAX_SCORE } from '../../database/models/conventions';
import {
  asRecord,
  readBoolean,
  readNumber,
  readObjectId,
  readObjectIdListQuery,
  readOptionalObjectIdQuery,
  readOptionalTrimmedString,
  readQueryValue,
  readRouteParam,
  readTrimmedString,
  rejectUnknownFields,
  requireAtLeastOneField,
  validationError,
} from '../../shared/validation/http';
import { isTwoDecimalScore, normalizeScore } from '../evaluations/evaluation-scoring';

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const V1_CURRENCY = 'INR';

const CREATE_FIELDS = [
  'moduleId',
  'title',
  'description',
  'type',
  'duration',
  'access',
  'availability',
  'scoring',
  'status',
] as const;

const UPDATE_FIELDS = [
  'title',
  'description',
  'duration',
  'access',
  'availability',
  'scoring',
  'status',
] as const;

export type AccessInput = {
  isFree?: boolean;
  price?: number;
  currency?: string;
};

export type AvailabilityInput = {
  startsAt: Date | null;
  endsAt: Date | null;
};

export type ScoringInput = {
  correctMarks?: number;
  incorrectMarks?: number;
  unansweredMarks?: number;
  maxScore: number;
};

export type ScoringPatch = {
  correctMarks?: number;
  incorrectMarks?: number;
  unansweredMarks?: number;
  maxScore?: number;
};

export type ResolvedAccess = {
  isFree: boolean;
  price: number;
  currency: string;
};

export type CreateTestSeriesInput = {
  moduleId: string;
  title: string;
  description: string;
  type: TestSeriesType;
  duration: number;
  access: ResolvedAccess;
  availability: AvailabilityInput;
  scoring: ScoringInput;
  status: CatalogStatus;
};

export type UpdateTestSeriesInput = {
  title?: string;
  description?: string;
  duration?: number;
  access?: AccessInput;
  availability?: AvailabilityInput;
  scoring?: ScoringPatch;
  status?: CatalogStatus;
};

export type CatalogTestSeriesListQuery = {
  categoryId?: string;
  moduleId?: string;
  type?: TestSeriesType;
  search?: string;
};

export type AdminTestSeriesListQuery = CatalogTestSeriesListQuery & {
  status?: CatalogStatus;
  ids?: string[];
};

function readCatalogStatus(value: unknown, field: string): CatalogStatus {
  const status = typeof value === 'string' ? value : null;

  if (status === null || !CATALOG_STATUSES.includes(status as CatalogStatus)) {
    throw validationError({ [field]: 'Must be ACTIVE, INACTIVE, or ARCHIVED.' });
  }

  return status as CatalogStatus;
}

function readTestSeriesType(value: unknown, field: string): TestSeriesType {
  if (typeof value !== 'string' || !TEST_SERIES_TYPES.includes(value as TestSeriesType)) {
    throw validationError({ [field]: 'Must be MCQ, PDF, or EDITOR.' });
  }

  return value as TestSeriesType;
}

function readDuration(value: unknown, field: string): number {
  const duration = readNumber(value, field);

  if (!Number.isInteger(duration) || duration <= 0) {
    throw validationError({ [field]: 'Must be a positive integer number of seconds.' });
  }

  return duration;
}

function readOptionalDate(value: unknown, field: string): Date | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError({ [field]: 'Must be an ISO 8601 timestamp or null.' });
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw validationError({ [field]: 'Must be a valid ISO 8601 timestamp.' });
  }

  return parsed;
}

function readAvailability(value: unknown): AvailabilityInput {
  if (value === undefined) {
    return { startsAt: null, endsAt: null };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ availability: 'Must be an object.' });
  }

  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, ['startsAt', 'endsAt']);

  const startsAt =
    record.startsAt === undefined
      ? null
      : readOptionalDate(record.startsAt, 'availability.startsAt');
  const endsAt =
    record.endsAt === undefined ? null : readOptionalDate(record.endsAt, 'availability.endsAt');

  if (startsAt != null && endsAt != null && startsAt >= endsAt) {
    throw validationError({
      'availability.endsAt': 'Must be after availability.startsAt.',
    });
  }

  return { startsAt, endsAt };
}

function readAccess(value: unknown): AccessInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ access: 'Must be an object.' });
  }

  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, ['isFree', 'price', 'currency']);

  return {
    ...(record.isFree !== undefined ? { isFree: readBoolean(record.isFree, 'access.isFree') } : {}),
    ...(record.price !== undefined ? { price: readNumber(record.price, 'access.price') } : {}),
    ...(record.currency !== undefined
      ? { currency: readTrimmedString(record.currency, 'access.currency', 8) }
      : {}),
  };
}

function readMaxScore(value: unknown, field: string): number {
  const maxScore = readNumber(value, field);

  if (maxScore <= 0) {
    throw validationError({ [field]: 'Must be a positive number.' });
  }

  if (!isTwoDecimalScore(maxScore)) {
    throw validationError({ [field]: 'Must have at most 2 decimal places.' });
  }

  return normalizeScore(maxScore);
}

function readScoring(value: unknown, type: TestSeriesType, required: boolean): ScoringInput {
  if (value === undefined) {
    if (type === 'MCQ' && required) {
      throw validationError({ scoring: 'MCQ test series require scoring configuration.' });
    }

    return { maxScore: DEFAULT_MAX_SCORE };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ scoring: 'Must be an object.' });
  }

  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, ['correctMarks', 'incorrectMarks', 'unansweredMarks', 'maxScore']);

  const hasMcqMarks =
    record.correctMarks !== undefined ||
    record.incorrectMarks !== undefined ||
    record.unansweredMarks !== undefined;

  if (type !== 'MCQ' && hasMcqMarks) {
    throw validationError({ scoring: 'MCQ mark fields are only applicable to MCQ test series.' });
  }

  if (type === 'MCQ') {
    if (
      record.correctMarks === undefined ||
      record.incorrectMarks === undefined ||
      record.unansweredMarks === undefined
    ) {
      throw validationError({ scoring: 'MCQ test series require scoring configuration.' });
    }

    return {
      correctMarks: readNumber(record.correctMarks, 'scoring.correctMarks'),
      incorrectMarks: readNumber(record.incorrectMarks, 'scoring.incorrectMarks'),
      unansweredMarks: readNumber(record.unansweredMarks, 'scoring.unansweredMarks'),
      maxScore:
        record.maxScore === undefined
          ? DEFAULT_MAX_SCORE
          : readMaxScore(record.maxScore, 'scoring.maxScore'),
    };
  }

  return {
    maxScore:
      record.maxScore === undefined
        ? DEFAULT_MAX_SCORE
        : readMaxScore(record.maxScore, 'scoring.maxScore'),
  };
}

function readScoringPatch(value: unknown): ScoringPatch {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ scoring: 'Must be an object.' });
  }

  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, ['correctMarks', 'incorrectMarks', 'unansweredMarks', 'maxScore']);

  if (
    record.correctMarks === undefined &&
    record.incorrectMarks === undefined &&
    record.unansweredMarks === undefined &&
    record.maxScore === undefined
  ) {
    throw validationError({ scoring: 'At least one scoring field is required.' });
  }

  return {
    ...(record.correctMarks !== undefined
      ? { correctMarks: readNumber(record.correctMarks, 'scoring.correctMarks') }
      : {}),
    ...(record.incorrectMarks !== undefined
      ? { incorrectMarks: readNumber(record.incorrectMarks, 'scoring.incorrectMarks') }
      : {}),
    ...(record.unansweredMarks !== undefined
      ? { unansweredMarks: readNumber(record.unansweredMarks, 'scoring.unansweredMarks') }
      : {}),
    ...(record.maxScore !== undefined
      ? { maxScore: readMaxScore(record.maxScore, 'scoring.maxScore') }
      : {}),
  };
}

export function resolveAccess(
  type: TestSeriesType,
  access: AccessInput | undefined,
): ResolvedAccess {
  if (type === 'MCQ') {
    if (access === undefined) {
      return { isFree: true, price: 0, currency: V1_CURRENCY };
    }

    if (
      (access.isFree !== undefined && access.isFree !== true) ||
      (access.price !== undefined && access.price !== 0) ||
      (access.currency !== undefined && access.currency !== V1_CURRENCY)
    ) {
      throw validationError({ access: 'MCQ test series must be free with currency INR.' });
    }

    return { isFree: true, price: 0, currency: V1_CURRENCY };
  }

  if (access === undefined || access.price === undefined) {
    throw validationError({ 'access.price': 'Paid test series require a positive price.' });
  }

  if (access.isFree === true) {
    throw validationError({ 'access.isFree': 'PDF and EDITOR test series must be paid.' });
  }

  if (!Number.isInteger(access.price) || access.price <= 0) {
    throw validationError({
      'access.price': 'Must be a positive integer number of paise.',
    });
  }

  if (access.currency !== undefined && access.currency !== V1_CURRENCY) {
    throw validationError({ 'access.currency': `Must be ${V1_CURRENCY}.` });
  }

  return { isFree: false, price: access.price, currency: V1_CURRENCY };
}

export function parseCreateTestSeriesInput(body: unknown): CreateTestSeriesInput {
  const record = asRecord(body);
  rejectUnknownFields(record, CREATE_FIELDS);

  const type = readTestSeriesType(record.type, 'type');
  const scoring = readScoring(record.scoring, type, true);

  return {
    moduleId: readObjectId(record.moduleId, 'moduleId'),
    title: readTrimmedString(record.title, 'title', TITLE_MAX_LENGTH),
    description: readOptionalTrimmedString(record, 'description', DESCRIPTION_MAX_LENGTH) ?? '',
    type,
    duration: readDuration(record.duration, 'duration'),
    access: resolveAccess(
      type,
      record.access === undefined ? undefined : readAccess(record.access),
    ),
    availability: readAvailability(record.availability),
    scoring,
    status: record.status === undefined ? 'ACTIVE' : readCatalogStatus(record.status, 'status'),
  };
}

export function parseUpdateTestSeriesInput(body: unknown): UpdateTestSeriesInput {
  const record = asRecord(body);
  rejectUnknownFields(record, UPDATE_FIELDS);
  requireAtLeastOneField(record, UPDATE_FIELDS);

  return {
    ...(record.title !== undefined
      ? { title: readTrimmedString(record.title, 'title', TITLE_MAX_LENGTH) }
      : {}),
    ...(record.description !== undefined
      ? {
          description:
            readOptionalTrimmedString(record, 'description', DESCRIPTION_MAX_LENGTH) ?? '',
        }
      : {}),
    ...(record.duration !== undefined
      ? { duration: readDuration(record.duration, 'duration') }
      : {}),
    ...(record.access !== undefined ? { access: readAccess(record.access) } : {}),
    ...(record.availability !== undefined
      ? { availability: readAvailability(record.availability) }
      : {}),
    ...(record.scoring !== undefined ? { scoring: readScoringPatch(record.scoring) } : {}),
    ...(record.status !== undefined ? { status: readCatalogStatus(record.status, 'status') } : {}),
  };
}

export function parseTestSeriesId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'testSeriesId');
}

function parseTypeQuery(query: Record<string, unknown>): TestSeriesType | undefined {
  const type = readQueryValue(query, 'type');

  if (type === undefined || type.trim() === '') {
    return undefined;
  }

  return readTestSeriesType(type, 'type');
}

export function parseCatalogTestSeriesListQuery(query: object): CatalogTestSeriesListQuery {
  const record = query as Record<string, unknown>;
  const search = readQueryValue(record, 'search');

  return {
    categoryId: readOptionalObjectIdQuery(record, 'categoryId'),
    moduleId: readOptionalObjectIdQuery(record, 'moduleId'),
    type: parseTypeQuery(record),
    search: search === undefined || search.trim() === '' ? undefined : search.trim(),
  };
}

export function parseAdminTestSeriesListQuery(query: object): AdminTestSeriesListQuery {
  const record = query as Record<string, unknown>;
  const status = readQueryValue(record, 'status');
  const ids = readObjectIdListQuery(record, 'ids');

  return {
    ...parseCatalogTestSeriesListQuery(record),
    status:
      status === undefined || status.trim() === ''
        ? undefined
        : readCatalogStatus(status, 'status'),
    ...(ids ? { ids } : {}),
  };
}
