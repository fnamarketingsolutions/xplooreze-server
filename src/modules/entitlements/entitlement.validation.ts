import type { EntitlementStatus } from '../../database/models/enums';
import { ENTITLEMENT_STATUSES } from '../../database/models/enums';
import {
  readOptionalDateQuery,
  readOptionalObjectIdQuery,
  readQueryValue,
  readRouteParam,
  validationError,
} from '../../shared/validation/http';

export type AdminEntitlementListQuery = {
  studentId?: string;
  testSeriesId?: string;
  status?: EntitlementStatus;
  grantedFrom?: Date;
  grantedTo?: Date;
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
  };
}

export function parseEntitlementId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'entitlementId');
}
