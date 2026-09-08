import type { EntitlementStatus } from '../../database/models/enums';
import { ENTITLEMENT_STATUSES } from '../../database/models/enums';
import {
  readOptionalDateQuery,
  readOptionalObjectIdQuery,
  readQueryValue,
  readRouteParam,
  validationError,
} from '../../shared/validation/http';

export type StudentEntitlementListQuery = {
  purchased?: boolean;
};

export type AdminEntitlementListQuery = {
  studentId?: string;
  testSeriesId?: string;
  status?: EntitlementStatus;
  grantedFrom?: Date;
  grantedTo?: Date;
  search?: string;
};

function readEntitlementStatus(value: string, field: string): EntitlementStatus {
  if (!(ENTITLEMENT_STATUSES as readonly string[]).includes(value)) {
    throw validationError({ [field]: `Must be one of ${ENTITLEMENT_STATUSES.join(', ')}.` });
  }

  return value as EntitlementStatus;
}

export function parseAdminEntitlementListQuery(query: object): AdminEntitlementListQuery {
  const record = query as Record<string, unknown>;
  const studentId = readOptionalObjectIdQuery(record, 'studentId');
  const testSeriesId = readOptionalObjectIdQuery(record, 'testSeriesId');
  const status = readQueryValue(record, 'status');
  const grantedFrom = readOptionalDateQuery(record, 'grantedFrom');
  const grantedTo = readOptionalDateQuery(record, 'grantedTo');
  const search = readQueryValue(record, 'search');

  if (grantedFrom && grantedTo && grantedFrom.getTime() > grantedTo.getTime()) {
    throw validationError({ grantedFrom: 'Must not be after grantedTo.' });
  }

  return {
    ...(studentId ? { studentId } : {}),
    ...(testSeriesId ? { testSeriesId } : {}),
    ...(status === undefined || status.trim() === ''
      ? {}
      : { status: readEntitlementStatus(status.trim(), 'status') }),
    ...(grantedFrom ? { grantedFrom } : {}),
    ...(grantedTo ? { grantedTo } : {}),
    ...(search === undefined || search.trim() === '' ? {} : { search: search.trim() }),
  };
}

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

/** My Access uses `purchased=true`. Default list still includes free MCQ entitlements. */
export function parseStudentEntitlementListQuery(query: object): StudentEntitlementListQuery {
  const purchased = readOptionalBooleanQuery(query as Record<string, unknown>, 'purchased');

  return {
    ...(purchased === undefined ? {} : { purchased }),
  };
}

export function parseEntitlementId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'entitlementId');
}
