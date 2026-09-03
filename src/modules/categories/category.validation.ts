import { CATALOG_STATUSES, type CatalogStatus } from '../../database/models/enums';
import {
  asRecord,
  readOptionalTrimmedString,
  readQueryValue,
  readRouteParam,
  readTrimmedString,
  rejectUnknownFields,
  requireAtLeastOneField,
  validationError,
} from '../../shared/validation/http';

export const NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;

const CREATE_FIELDS = ['name', 'description', 'status'] as const;
const UPDATE_FIELDS = ['name', 'description', 'status'] as const;

export type CreateCategoryInput = {
  name: string;
  description: string;
  status: CatalogStatus;
};

export type UpdateCategoryInput = {
  name?: string;
  description?: string;
  status?: CatalogStatus;
};

export type ListCategoriesQuery = {
  status?: CatalogStatus;
};

function readCatalogStatus(value: unknown, field: string): CatalogStatus {
  const status = typeof value === 'string' ? value : null;

  if (status === null || !CATALOG_STATUSES.includes(status as CatalogStatus)) {
    throw validationError({ [field]: 'Must be ACTIVE, INACTIVE, or ARCHIVED.' });
  }

  return status as CatalogStatus;
}

export function parseCreateCategoryInput(body: unknown): CreateCategoryInput {
  const record = asRecord(body);
  rejectUnknownFields(record, CREATE_FIELDS);

  return {
    name: readTrimmedString(record.name, 'name', NAME_MAX_LENGTH),
    description: readOptionalTrimmedString(record, 'description', DESCRIPTION_MAX_LENGTH) ?? '',
    status: record.status === undefined ? 'ACTIVE' : readCatalogStatus(record.status, 'status'),
  };
}

export function parseUpdateCategoryInput(body: unknown): UpdateCategoryInput {
  const record = asRecord(body);
  rejectUnknownFields(record, UPDATE_FIELDS);
  requireAtLeastOneField(record, UPDATE_FIELDS);

  return {
    ...(record.name !== undefined
      ? { name: readTrimmedString(record.name, 'name', NAME_MAX_LENGTH) }
      : {}),
    ...(record.description !== undefined
      ? {
          description:
            readOptionalTrimmedString(record, 'description', DESCRIPTION_MAX_LENGTH) ?? '',
        }
      : {}),
    ...(record.status !== undefined ? { status: readCatalogStatus(record.status, 'status') } : {}),
  };
}

export function parseCategoryId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'categoryId');
}

export function parseAdminCategoryListQuery(query: object): ListCategoriesQuery {
  const record = query as Record<string, unknown>;
  const status = readQueryValue(record, 'status');

  return {
    status:
      status === undefined || status.trim() === ''
        ? undefined
        : readCatalogStatus(status, 'status'),
  };
}
