import { CATALOG_STATUSES, TEST_SERIES_TYPES } from '../../database/models/enums';
import type { CatalogStatus, TestSeriesType } from '../../database/models/enums';
import {
  asRecord,
  readNumber,
  readObjectId,
  readOptionalObjectIdQuery,
  readOptionalTrimmedString,
  readQueryValue,
  readRouteParam,
  readTrimmedString,
  rejectUnknownFields,
  requireAtLeastOneField,
  validationError,
} from '../../shared/validation/http';

export const QUESTION_TEXT_MAX_LENGTH = 10_000;
export const OPTION_TEXT_MAX_LENGTH = 2000;
export const OPTION_ID_MAX_LENGTH = 64;

const CREATE_FIELDS = [
  'testSeriesId',
  'type',
  'position',
  'questionText',
  'content',
  'status',
] as const;
const UPDATE_FIELDS = ['position', 'questionText', 'content', 'status'] as const;

/** Client fields that would invent unsupported EDITOR capabilities. */
const UNSUPPORTED_EDITOR_CAPABILITY_FIELDS = [
  'images',
  'tables',
  'equations',
  'latex',
  'attachments',
  'code',
  'sandbox',
  'testCases',
  'testcases',
  'execution',
] as const;

export type McqOptionInput = {
  id: string;
  text: string;
};

export type McqContentInput = {
  options: McqOptionInput[];
  correctOptionId: string;
};

export type FlexibleContentInput = Record<string, unknown>;

export type CreateQuestionInput = {
  testSeriesId: string;
  /** Optional client hint; must match the parent Test Series type when provided. */
  type?: TestSeriesType;
  position: number;
  questionText: string;
  content: unknown;
  status: CatalogStatus;
};

export type UpdateQuestionInput = {
  position?: number;
  questionText?: string;
  content?: unknown;
  status?: CatalogStatus;
};

export type AdminQuestionListQuery = {
  testSeriesId: string;
  status?: CatalogStatus;
  type?: TestSeriesType;
};

function readCatalogStatus(value: unknown, field: string): CatalogStatus {
  const status = typeof value === 'string' ? value : null;

  if (status === 'DRAFT') {
    throw validationError({ [field]: 'DRAFT is not a valid question status.' });
  }

  if (status === null || !CATALOG_STATUSES.includes(status as CatalogStatus)) {
    throw validationError({ [field]: 'Must be ACTIVE, INACTIVE, or ARCHIVED.' });
  }

  return status as CatalogStatus;
}

function readQuestionType(value: unknown, field: string): TestSeriesType {
  if (typeof value !== 'string') {
    throw validationError({ [field]: 'Must be MCQ, PDF, or EDITOR.' });
  }

  if (value === 'WRITTEN') {
    throw validationError({ [field]: 'WRITTEN is not a valid question type.' });
  }

  if (!TEST_SERIES_TYPES.includes(value as TestSeriesType)) {
    throw validationError({ [field]: 'Must be MCQ, PDF, or EDITOR.' });
  }

  return value as TestSeriesType;
}

function readPosition(value: unknown, field: string): number {
  const position = readNumber(value, field);

  if (!Number.isInteger(position) || position < 1) {
    throw validationError({ [field]: 'Must be an integer greater than or equal to 1.' });
  }

  return position;
}

function readOptionId(value: unknown, field: string): string {
  return readTrimmedString(value, field, OPTION_ID_MAX_LENGTH);
}

function readMcqOptions(value: unknown): McqOptionInput[] {
  if (!Array.isArray(value)) {
    throw validationError({ 'content.options': 'Must be an array.' });
  }

  if (value.length === 0) {
    throw validationError({ 'content.options': 'Must contain at least one option.' });
  }

  const options: McqOptionInput[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw validationError({ [`content.options[${index}]`]: 'Must be an object.' });
    }

    const record = entry as Record<string, unknown>;
    rejectUnknownFields(record, ['id', 'text']);

    const id = readOptionId(record.id, `content.options[${index}].id`);

    if (seen.has(id)) {
      throw validationError({
        [`content.options[${index}].id`]: 'Option identifiers must be unique.',
      });
    }

    seen.add(id);
    options.push({
      id,
      text: readTrimmedString(
        record.text,
        `content.options[${index}].text`,
        OPTION_TEXT_MAX_LENGTH,
      ),
    });
  }

  return options;
}

function readMcqContent(value: unknown): McqContentInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ content: 'Must be an object.' });
  }

  const record = value as Record<string, unknown>;

  if (record.correctOptionIds !== undefined) {
    throw validationError({
      'content.correctOptionIds': 'Multi-select answers are not supported. Use correctOptionId.',
    });
  }

  rejectUnknownFields(record, ['options', 'correctOptionId']);

  const options = readMcqOptions(record.options);
  const correctOptionId = readOptionId(record.correctOptionId, 'content.correctOptionId');

  if (!options.some((option) => option.id === correctOptionId)) {
    throw validationError({
      'content.correctOptionId': 'Must reference one of the option identifiers.',
    });
  }

  return { options, correctOptionId };
}

function rejectUnsupportedEditorCapabilities(
  record: Record<string, unknown>,
  prefix: string,
): void {
  for (const field of UNSUPPORTED_EDITOR_CAPABILITY_FIELDS) {
    if (record[field] !== undefined) {
      throw validationError({
        [`${prefix}${field}`]: 'Unsupported EDITOR capability in V1.',
      });
    }
  }
}

function readFlexibleContent(value: unknown, type: 'PDF' | 'EDITOR'): FlexibleContentInput {
  if (value === undefined) {
    return {};
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ content: 'Must be an object.' });
  }

  const record = value as Record<string, unknown>;

  if (type === 'EDITOR') {
    rejectUnsupportedEditorCapabilities(record, 'content.');
  }

  // Preserve the canonical flexible Mixed representation without inventing a PDF/EDITOR schema.
  return { ...record };
}

export function parseQuestionContentForType(
  type: TestSeriesType,
  content: unknown,
  questionText: string,
): McqContentInput | FlexibleContentInput {
  if (type === 'MCQ') {
    if (questionText.trim() === '') {
      throw validationError({ questionText: 'MCQ questions require question text.' });
    }

    if (content === undefined) {
      throw validationError({ content: 'MCQ questions require content with options.' });
    }

    return readMcqContent(content);
  }

  if (type === 'PDF') {
    return readFlexibleContent(content, 'PDF');
  }

  return readFlexibleContent(content, 'EDITOR');
}

function readOptionalQuestionText(record: Record<string, unknown>): string {
  if (record.questionText === undefined) {
    return '';
  }

  if (typeof record.questionText !== 'string') {
    throw validationError({ questionText: 'Must be a string.' });
  }

  const trimmed = record.questionText.trim();

  if (trimmed.length > QUESTION_TEXT_MAX_LENGTH) {
    throw validationError({
      questionText: `Must be at most ${QUESTION_TEXT_MAX_LENGTH} characters.`,
    });
  }

  return trimmed;
}

export function parseCreateQuestionInput(body: unknown): CreateQuestionInput {
  const record = asRecord(body);
  rejectUnknownFields(record, CREATE_FIELDS);

  return {
    testSeriesId: readObjectId(record.testSeriesId, 'testSeriesId'),
    ...(record.type !== undefined ? { type: readQuestionType(record.type, 'type') } : {}),
    position: readPosition(record.position, 'position'),
    questionText: readOptionalQuestionText(record),
    content: record.content,
    status: record.status === undefined ? 'ACTIVE' : readCatalogStatus(record.status, 'status'),
  };
}

export function parseUpdateQuestionInput(body: unknown): UpdateQuestionInput {
  const record = asRecord(body);
  rejectUnknownFields(record, UPDATE_FIELDS);
  requireAtLeastOneField(record, UPDATE_FIELDS);

  return {
    ...(record.position !== undefined
      ? { position: readPosition(record.position, 'position') }
      : {}),
    ...(record.questionText !== undefined
      ? {
          questionText:
            readOptionalTrimmedString(record, 'questionText', QUESTION_TEXT_MAX_LENGTH) ?? '',
        }
      : {}),
    ...(record.content !== undefined ? { content: record.content } : {}),
    ...(record.status !== undefined ? { status: readCatalogStatus(record.status, 'status') } : {}),
  };
}

export function parseQuestionId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'questionId');
}

export function parseAdminQuestionListQuery(query: object): AdminQuestionListQuery {
  const record = query as Record<string, unknown>;
  const testSeriesId = readOptionalObjectIdQuery(record, 'testSeriesId');

  if (!testSeriesId) {
    throw validationError({ testSeriesId: 'Must be a valid id.' });
  }

  const status = readQueryValue(record, 'status');
  const type = readQueryValue(record, 'type');

  let parsedType: TestSeriesType | undefined;

  if (type !== undefined && type.trim() !== '') {
    if (type === 'WRITTEN') {
      throw validationError({ type: 'WRITTEN is not a valid question type.' });
    }

    if (!TEST_SERIES_TYPES.includes(type as TestSeriesType)) {
      throw validationError({ type: 'Must be MCQ, PDF, or EDITOR.' });
    }

    parsedType = type as TestSeriesType;
  }

  return {
    testSeriesId,
    status:
      status === undefined || status.trim() === ''
        ? undefined
        : readCatalogStatus(status, 'status'),
    type: parsedType,
  };
}
