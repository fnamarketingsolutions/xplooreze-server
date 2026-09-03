import { CATALOG_STATUSES, type CatalogStatus } from '../../database/models/enums';
import {
  asRecord,
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

export const NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;

const CREATE_FIELDS = ['categoryId', 'name', 'description', 'status'] as const;
const UPDATE_FIELDS = ['name', 'description', 'status'] as const;

export type CreateModuleInput = {
  categoryId: string;
  name: string;
  description: string;
  status: CatalogStatus;
};

export type UpdateModuleInput = {
  name?: string;
  description?: string;
  status?: CatalogStatus;
};

export type CatalogModuleListQuery = {
  categoryId?: string;
};

export type AdminModuleListQuery = {
  categoryId?: string;
  status?: CatalogStatus;
};

function readCatalogStatus(value: unknown, field: string): CatalogStatus {
  const status = typeof value === 'string' ? value : null;

  if (status === null || !CATALOG_STATUSES.includes(status as CatalogStatus)) {
    throw validationError({ [field]: 'Must be ACTIVE, INACTIVE, or ARCHIVED.' });
  }

  return status as CatalogStatus;
}

export function parseCreateModuleInput(body: unknown): CreateModuleInput {
  const record = asRecord(body);
  rejectUnknownFields(record, CREATE_FIELDS);

  return {
    categoryId: readObjectId(record.categoryId, 'categoryId'),
    name: readTrimmedString(record.name, 'name', NAME_MAX_LENGTH),
    description: readOptionalTrimmedString(record, 'description', DESCRIPTION_MAX_LENGTH) ?? '',
    status: record.status === undefined ? 'ACTIVE' : readCatalogStatus(record.status, 'status'),
  };
}

export function parseUpdateModuleInput(body: unknown): UpdateModuleInput {
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

export function parseModuleId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'moduleId');
}

export function parseCatalogModuleListQuery(query: object): CatalogModuleListQuery {
  const record = query as Record<string, unknown>;
  return {
    categoryId: readOptionalObjectIdQuery(record, 'categoryId'),
  };
}

export function parseAdminModuleListQuery(query: object): AdminModuleListQuery {
  const record = query as Record<string, unknown>;
  const status = readQueryValue(record, 'status');

  return {
    categoryId: readOptionalObjectIdQuery(record, 'categoryId'),
    status:
      status === undefined || status.trim() === ''
        ? undefined
        : readCatalogStatus(status, 'status'),
  };
}
