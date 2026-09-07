import type { PurchaseStatus } from '../../database/models/enums';
import { PURCHASE_STATUSES } from '../../database/models/enums';
import {
  asRecord,
  readObjectId,
  readOptionalDateQuery,
  readOptionalObjectIdQuery,
  readQueryValue,
  readRouteParam,
  rejectUnknownFields,
  validationError,
} from '../../shared/validation/http';

const CREATE_FIELDS = ['testSeriesId'] as const;

export type CreatePurchaseInput = {
  testSeriesId: string;
};

export type AdminPurchaseListQuery = {
  studentId?: string;
  testSeriesId?: string;
  status?: PurchaseStatus;
  createdFrom?: Date;
  createdTo?: Date;
  search?: string;
};

function readPurchaseStatus(value: string, field: string): PurchaseStatus {
  if (!(PURCHASE_STATUSES as readonly string[]).includes(value)) {
    throw validationError({ [field]: `Must be one of ${PURCHASE_STATUSES.join(', ')}.` });
  }

  return value as PurchaseStatus;
}

export function parseAdminPurchaseListQuery(query: object): AdminPurchaseListQuery {
  const record = query as Record<string, unknown>;
  const studentId = readOptionalObjectIdQuery(record, 'studentId');
  const testSeriesId = readOptionalObjectIdQuery(record, 'testSeriesId');
  const status = readQueryValue(record, 'status');
  const createdFrom = readOptionalDateQuery(record, 'createdFrom');
  const createdTo = readOptionalDateQuery(record, 'createdTo');
  const search = readQueryValue(record, 'search');

  if (createdFrom && createdTo && createdFrom.getTime() > createdTo.getTime()) {
    throw validationError({ createdFrom: 'Must not be after createdTo.' });
  }

  return {
    ...(studentId ? { studentId } : {}),
    ...(testSeriesId ? { testSeriesId } : {}),
    ...(status === undefined || status.trim() === ''
      ? {}
      : { status: readPurchaseStatus(status.trim(), 'status') }),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdTo ? { createdTo } : {}),
    ...(search === undefined || search.trim() === '' ? {} : { search: search.trim() }),
  };
}

export function parseCreatePurchaseInput(body: unknown): CreatePurchaseInput {
  const record = asRecord(body);
  rejectUnknownFields(record, CREATE_FIELDS);

  return {
    testSeriesId: readObjectId(record.testSeriesId, 'testSeriesId'),
  };
}

export function parsePurchaseId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'purchaseId');
}
