import type { EvaluationMode, EvaluationStatus } from '../../database/models/enums';
import {
  asRecord,
  readNumber,
  readObjectId,
  readOptionalTrimmedString,
  readQueryValue,
  readRouteParam,
  rejectUnknownFields,
  requireAtLeastOneField,
  validationError,
} from '../../shared/validation/http';
import { normalizeScore } from './evaluation-scoring';

export const REMARKS_MAX_LENGTH = 2000;

const ASSIGN_FIELDS = ['evaluatorId'] as const;
const UPDATE_FIELDS = ['score', 'remarks'] as const;
const EMPTY_BODY_FIELDS = [] as const;

export type AssignEvaluatorInput = {
  evaluatorId: string;
};

export type UpdateEvaluationInput = {
  score?: number;
  remarks?: string | null;
};

export type AdminEvaluationListQuery = {
  status?: EvaluationStatus;
  mode?: EvaluationMode;
};

function readEvaluationStatus(value: string, field: string): EvaluationStatus {
  if (
    value !== 'UNASSIGNED' &&
    value !== 'ASSIGNED' &&
    value !== 'IN_PROGRESS' &&
    value !== 'COMPLETED' &&
    value !== 'FINALIZED'
  ) {
    throw validationError({ [field]: 'Must be a valid evaluation status.' });
  }

  return value;
}

function readEvaluationMode(value: string, field: string): EvaluationMode {
  if (value !== 'AUTOMATIC' && value !== 'MANUAL') {
    throw validationError({ [field]: 'Must be AUTOMATIC or MANUAL.' });
  }

  return value;
}

function readManualScore(value: number, field: string): number {
  if (value < 0) {
    throw validationError({ [field]: 'Must not be negative.' });
  }

  return normalizeScore(value);
}

export function parseEvaluationId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'evaluationId');
}

export function parseAssignEvaluatorInput(body: unknown): AssignEvaluatorInput {
  const record = asRecord(body);
  rejectUnknownFields(record, ASSIGN_FIELDS);

  return {
    evaluatorId: readObjectId(record.evaluatorId, 'evaluatorId'),
  };
}

export function parseUpdateEvaluationInput(body: unknown): UpdateEvaluationInput {
  const record = asRecord(body);
  rejectUnknownFields(record, UPDATE_FIELDS);
  requireAtLeastOneField(record, UPDATE_FIELDS);

  const score =
    record.score === undefined
      ? undefined
      : readManualScore(readNumber(record.score, 'score'), 'score');

  let remarks: string | null | undefined;
  if (record.remarks === null) {
    remarks = null;
  } else if (record.remarks !== undefined) {
    remarks = readOptionalTrimmedString(record, 'remarks', REMARKS_MAX_LENGTH) ?? '';
  }

  return {
    ...(score !== undefined ? { score } : {}),
    ...(remarks !== undefined ? { remarks } : {}),
  };
}

export function parseEmptyEvaluationBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }

  const record = asRecord(body);
  rejectUnknownFields(record, EMPTY_BODY_FIELDS);
}

export function parseAdminEvaluationListQuery(query: object): AdminEvaluationListQuery {
  const record = query as Record<string, unknown>;
  const status = readQueryValue(record, 'status');
  const mode = readQueryValue(record, 'mode');

  return {
    status:
      status === undefined || status.trim() === ''
        ? undefined
        : readEvaluationStatus(status, 'status'),
    mode: mode === undefined || mode.trim() === '' ? undefined : readEvaluationMode(mode, 'mode'),
  };
}

export function parseEvaluatorListQuery(query: object): void {
  const record = query as Record<string, unknown>;

  if (record.evaluatorId !== undefined) {
    throw validationError({ evaluatorId: 'Field is not allowed.' });
  }

  if (record.categoryId !== undefined) {
    throw validationError({ categoryId: 'Field is not allowed.' });
  }
}
