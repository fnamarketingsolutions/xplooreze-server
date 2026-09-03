import type { TestSeriesSummaryDto } from '../test-series/test-series-summary';

export type EntitlementTestSeriesSummaryDto = TestSeriesSummaryDto;

/**
 * Attempts counted against this entitlement only.
 * Free MCQ: max/remaining are null (unlimited). Paid PDF/EDITOR: max is 3.
 */
export type EntitlementAttemptUsageDto = {
  used: number;
  max: number | null;
  remaining: number | null;
};

export type EntitlementDto = {
  id: string;
  studentId: string;
  testSeriesId: string;
  purchaseId: string | null;
  status: string;
  grantedAt: string;
  startsAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  testSeries: EntitlementTestSeriesSummaryDto | null;
  attempts: EntitlementAttemptUsageDto | null;
};

type EntitlementLike = {
  _id: { toString(): string };
  studentId: { toString(): string };
  testSeriesId: { toString(): string };
  purchaseId?: { toString(): string } | null;
  status: string;
  grantedAt: Date;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toEntitlementDto(
  entitlement: EntitlementLike,
  testSeries: EntitlementTestSeriesSummaryDto | null = null,
  attempts: EntitlementAttemptUsageDto | null = null,
): EntitlementDto {
  const grantedAt = entitlement.grantedAt.toISOString();

  return {
    id: entitlement._id.toString(),
    studentId: entitlement.studentId.toString(),
    testSeriesId: entitlement.testSeriesId.toString(),
    purchaseId: entitlement.purchaseId ? entitlement.purchaseId.toString() : null,
    status: entitlement.status,
    grantedAt,
    startsAt: grantedAt,
    expiresAt: entitlement.expiresAt ? entitlement.expiresAt.toISOString() : null,
    createdAt: entitlement.createdAt.toISOString(),
    updatedAt: entitlement.updatedAt.toISOString(),
    testSeries,
    attempts,
  };
}
