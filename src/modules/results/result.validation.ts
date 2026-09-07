import {
  asRecord,
  readQueryValue,
  readRouteParam,
  rejectUnknownFields,
  validationError,
} from '../../shared/validation/http';

const EMPTY_BODY_FIELDS = [] as const;
const STUDENT_LIST_QUERY_FIELDS = ['page', 'limit'] as const;
const ADMIN_LIST_QUERY_FIELDS = ['page', 'limit', 'search'] as const;

const FORBIDDEN_CLIENT_FIELDS = [
  'studentId',
  'attemptId',
  'evaluationId',
  'evaluationRevisionId',
  'score',
  'maxScore',
  'percentage',
  'status',
  'publishedAt',
] as const;

export type AdminResultListQuery = {
  search?: string;
};

export function parseResultId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'resultId');
}

export function parseEmptyResultBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }

  const record = asRecord(body);
  rejectUnknownFields(record, EMPTY_BODY_FIELDS);
}

function rejectOperatorKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (key.startsWith('$')) {
      throw validationError({ [key]: 'Field is not allowed.' });
    }
  }
}

function rejectForbiddenClientFields(record: Record<string, unknown>): void {
  for (const field of FORBIDDEN_CLIENT_FIELDS) {
    if (record[field] !== undefined) {
      throw validationError({ [field]: 'Field is not allowed.' });
    }
  }
}

export function parseStudentResultListQuery(query: object): void {
  const record = query as Record<string, unknown>;
  rejectOperatorKeys(record);
  rejectForbiddenClientFields(record);
  rejectUnknownFields(record, STUDENT_LIST_QUERY_FIELDS);

  for (const field of STUDENT_LIST_QUERY_FIELDS) {
    readQueryValue(record, field);
  }
}

export function parseAdminResultListQuery(query: object): AdminResultListQuery {
  const record = query as Record<string, unknown>;
  rejectOperatorKeys(record);
  rejectForbiddenClientFields(record);
  rejectUnknownFields(record, ADMIN_LIST_QUERY_FIELDS);

  for (const field of ADMIN_LIST_QUERY_FIELDS) {
    readQueryValue(record, field);
  }

  const search = readQueryValue(record, 'search');
  return {
    ...(search === undefined || search.trim() === '' ? {} : { search: search.trim() }),
  };
}
