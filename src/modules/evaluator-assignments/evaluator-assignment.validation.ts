import {
  asRecord,
  readBoolean,
  readObjectId,
  readOptionalObjectIdQuery,
  readQueryValue,
  readRouteParam,
  rejectUnknownFields,
  validationError,
} from '../../shared/validation/http';

const CREATE_FIELDS = ['evaluatorId', 'categoryId'] as const;
const UPDATE_FIELDS = ['isActive'] as const;

export type CreateEvaluatorCategoryAssignmentInput = {
  evaluatorId: string;
  categoryId: string;
};

export type UpdateEvaluatorCategoryAssignmentInput = {
  isActive: boolean;
};

export type EvaluatorCategoryAssignmentListQuery = {
  categoryId?: string;
  evaluatorId?: string;
};

export type GroupedEvaluatorCategoryAssignmentListQuery = EvaluatorCategoryAssignmentListQuery & {
  isActive?: boolean;
};

function readOptionalBooleanQuery(
  query: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = readQueryValue(query, field);

  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw validationError({ [field]: 'Must be true or false.' });
}

export function parseCreateEvaluatorCategoryAssignmentInput(
  body: unknown,
): CreateEvaluatorCategoryAssignmentInput {
  const record = asRecord(body);
  rejectUnknownFields(record, CREATE_FIELDS);

  return {
    evaluatorId: readObjectId(record.evaluatorId, 'evaluatorId'),
    categoryId: readObjectId(record.categoryId, 'categoryId'),
  };
}

export function parseUpdateEvaluatorCategoryAssignmentInput(
  body: unknown,
): UpdateEvaluatorCategoryAssignmentInput {
  const record = asRecord(body);
  rejectUnknownFields(record, UPDATE_FIELDS);

  if (record.isActive === undefined) {
    throw validationError({ isActive: 'Must be a boolean.' });
  }

  return {
    isActive: readBoolean(record.isActive, 'isActive'),
  };
}

export function parseEvaluatorCategoryAssignmentListQuery(
  query: object,
): EvaluatorCategoryAssignmentListQuery {
  const record = query as Record<string, unknown>;
  return {
    categoryId: readOptionalObjectIdQuery(record, 'categoryId'),
    evaluatorId: readOptionalObjectIdQuery(record, 'evaluatorId'),
  };
}

export function parseGroupedEvaluatorCategoryAssignmentListQuery(
  query: object,
): GroupedEvaluatorCategoryAssignmentListQuery {
  const record = query as Record<string, unknown>;
  return {
    ...parseEvaluatorCategoryAssignmentListQuery(query),
    isActive: readOptionalBooleanQuery(record, 'isActive'),
  };
}

export function parseAssignmentId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'assignmentId');
}
