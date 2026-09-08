import type { ClientSession } from 'mongoose';

import { PAID_ENTITLEMENT_VALIDITY_DAYS, V1_MAX_ATTEMPTS, isUnlimitedAttemptPath } from '../../database/models/conventions';
import { remapDuplicateKey } from '../../database/errors';
import type { EntitlementListFilter } from '../../database/repositories/access.repository';
import {
  attemptRepository,
  entitlementRepository,
  testSeriesRepository,
} from '../../database/repositories/index';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { resolveStudentOrTestSeriesSearch } from '../admin-list-search';
import { buildTestSeriesSummaryByIds } from '../test-series/test-series-summary';
import { toEntitlementDto } from './entitlement.dto';
import type { EntitlementDto } from './entitlement.dto';
import type { AdminEntitlementListQuery, StudentEntitlementListQuery } from './entitlement.validation';

function entitlementNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.ENTITLEMENT_NOT_FOUND,
    message: 'Entitlement not found.',
  });
}

function activeEntitlementExists(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.ACTIVE_ENTITLEMENT_EXISTS,
    message: 'An active entitlement already exists for this test series.',
  });
}

function entitlementInvariantViolated(message: string): AppError {
  return new AppError({
    statusCode: 500,
    code: ErrorCodes.INTERNAL_SERVER_ERROR,
    message,
  });
}

export function addPaidEntitlementValidity(grantedAt: Date): Date {
  const expiresAt = new Date(grantedAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + PAID_ENTITLEMENT_VALIDITY_DAYS);
  return expiresAt;
}

/** Paid access: ACTIVE and expiresAt > now. Null expiresAt is not a valid paid grant. */
export function isEntitlementUnexpired(
  entitlement: { status: string; expiresAt: Date | null },
  now = new Date(),
): boolean {
  return (
    entitlement.status === 'ACTIVE' &&
    entitlement.expiresAt != null &&
    entitlement.expiresAt.getTime() > now.getTime()
  );
}

/**
 * Paid entitlement lookup: ACTIVE + unexpired.
 * Normalizes stale ACTIVE+expired rows to EXPIRED.
 * Does not apply to free MCQ (null expiresAt); callers for free MCQ must not use this.
 */
export async function findValidActiveEntitlement(
  studentId: string,
  testSeriesId: string,
  now = new Date(),
  session?: ClientSession,
) {
  const entitlement = await entitlementRepository.findActiveByStudentAndTestSeries(
    studentId,
    testSeriesId,
    session ? { session } : undefined,
  );

  if (!entitlement) {
    return null;
  }

  // Free MCQ entitlements have expiresAt = null; they are not time-bound.
  if (entitlement.expiresAt == null) {
    return entitlement;
  }

  if (!isEntitlementUnexpired(entitlement, now)) {
    await entitlementRepository.updateById(
      entitlement._id,
      { $set: { status: 'EXPIRED' } },
      session ? { session } : undefined,
    );
    return null;
  }

  return entitlement;
}

/**
 * Access check for later Attempt phase.
 * Paid: ACTIVE entitlement and expiresAt > now.
 * Free MCQ: access without purchase; ACTIVE entitlement is not expiry-gated.
 */
export async function studentHasTestSeriesAccess(
  studentId: string,
  testSeriesId: string,
  now = new Date(),
): Promise<{
  hasAccess: boolean;
  reason?: 'TEST_SERIES_NOT_FOUND' | 'ENTITLEMENT_REQUIRED' | 'ENTITLEMENT_EXPIRED';
  entitlementId?: string;
}> {
  const testSeries = await testSeriesRepository.findById(testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    return { hasAccess: false, reason: 'TEST_SERIES_NOT_FOUND' };
  }

  if (testSeries.type === 'MCQ' || testSeries.access.isFree) {
    const entitlement = await entitlementRepository.findActiveByStudentAndTestSeries(
      studentId,
      testSeriesId,
    );
    return {
      hasAccess: true,
      ...(entitlement ? { entitlementId: entitlement._id.toString() } : {}),
    };
  }

  const active = await entitlementRepository.findActiveByStudentAndTestSeries(
    studentId,
    testSeriesId,
  );

  if (!active) {
    return { hasAccess: false, reason: 'ENTITLEMENT_REQUIRED' };
  }

  if (!isEntitlementUnexpired(active, now)) {
    await entitlementRepository.updateById(active._id, { $set: { status: 'EXPIRED' } });
    return { hasAccess: false, reason: 'ENTITLEMENT_EXPIRED' };
  }

  return {
    hasAccess: true,
    entitlementId: active._id.toString(),
  };
}

export async function createPaidEntitlement(input: {
  studentId: string;
  testSeriesId: string;
  purchaseId: string;
  grantedAt: Date;
  session?: ClientSession;
}) {
  if (!input.purchaseId) {
    throw entitlementInvariantViolated('Paid entitlement requires a non-null purchaseId.');
  }

  // Paid invariant: purchaseId != null AND expiresAt = grantedAt + 60 days.
  const expiresAt = addPaidEntitlementValidity(input.grantedAt);

  try {
    return await entitlementRepository.create(
      {
        studentId: input.studentId,
        testSeriesId: input.testSeriesId,
        purchaseId: input.purchaseId,
        status: 'ACTIVE',
        grantedAt: input.grantedAt,
        expiresAt,
      },
      input.session ? { session: input.session } : undefined,
    );
  } catch (error) {
    remapDuplicateKey(error, activeEntitlementExists());
  }
}

/**
 * Free MCQ entitlement: no Purchase, purchaseId = null, expiresAt = null.
 * Access checks for free MCQ do not depend on entitlement expiry.
 */
export async function ensureFreeMcqEntitlement(studentId: string, testSeriesId: string) {
  const testSeries = await testSeriesRepository.findById(testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCodes.TEST_SERIES_NOT_FOUND,
      message: 'Test series not found.',
    });
  }

  if (testSeries.type !== 'MCQ' || !testSeries.access.isFree) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.TEST_SERIES_NOT_PURCHASABLE,
      message: 'Only free MCQ test series can be acquired without payment.',
    });
  }

  const existing = await entitlementRepository.findActiveByStudentAndTestSeries(
    studentId,
    testSeriesId,
  );

  if (existing) {
    return toEntitlementDto(existing);
  }

  const grantedAt = new Date();

  try {
    const created = await entitlementRepository.create({
      studentId,
      testSeriesId,
      purchaseId: null,
      status: 'ACTIVE',
      grantedAt,
      expiresAt: null,
    });

    if (created.purchaseId != null || created.expiresAt != null) {
      throw entitlementInvariantViolated(
        'Free MCQ entitlement must have purchaseId = null and expiresAt = null.',
      );
    }

    return toEntitlementDto(created);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    const raced = await entitlementRepository.findActiveByStudentAndTestSeries(
      studentId,
      testSeriesId,
    );
    if (raced) {
      return toEntitlementDto(raced);
    }
    remapDuplicateKey(error, activeEntitlementExists());
  }
}

export async function listStudentEntitlements(
  studentId: string,
  pagination: PaginationInput,
  query: StudentEntitlementListQuery = {},
) {
  const purchasedOnly = query.purchased === true;
  const filter: EntitlementListFilter = {
    studentId,
    ...(purchasedOnly ? { purchaseId: { $ne: null } } : {}),
  };
  const [items, total] = await Promise.all([
    entitlementRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      // Purchased wallet: usable grants first, then expired, then revoked.
      sort: purchasedOnly ? { status: 1, createdAt: -1 } : { createdAt: -1 },
    }),
    entitlementRepository.count(filter),
  ]);

  return {
    items: await toEnrichedEntitlementDtos(items as EntitlementDocument[], {
      includeAttempts: true,
    }),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getStudentEntitlement(studentId: string, entitlementId: string) {
  const entitlement = await entitlementRepository.findById(entitlementId);

  if (!entitlement || entitlement.studentId.toString() !== studentId) {
    throw entitlementNotFound();
  }

  const [dto] = await toEnrichedEntitlementDtos([entitlement as EntitlementDocument], {
    includeAttempts: true,
  });
  return dto;
}

function toAdminEntitlementFilter(query: AdminEntitlementListQuery): EntitlementListFilter {
  const grantedAt = {
    ...(query.grantedFrom ? { $gte: query.grantedFrom } : {}),
    ...(query.grantedTo ? { $lte: query.grantedTo } : {}),
  };

  return {
    ...(query.studentId ? { studentId: query.studentId } : {}),
    ...(query.testSeriesId ? { testSeriesId: query.testSeriesId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(Object.keys(grantedAt).length > 0 ? { grantedAt } : {}),
  };
}

export async function listAdminEntitlements(
  pagination: PaginationInput,
  query: AdminEntitlementListQuery = {},
) {
  const filter = toAdminEntitlementFilter(query);

  if (query.search) {
    const resolved = await resolveStudentOrTestSeriesSearch(query.search);
    if (resolved.kind === 'empty') {
      return {
        items: [],
        pagination: toPaginationMeta(pagination, 0),
      };
    }
    filter.$or = resolved.$or;
  }

  const [items, total] = await Promise.all([
    entitlementRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { createdAt: -1 },
    }),
    entitlementRepository.count(filter),
  ]);

  return {
    items: await toEnrichedEntitlementDtos(items as EntitlementDocument[], {
      includeAttempts: true,
    }),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getAdminEntitlement(entitlementId: string) {
  const entitlement = await entitlementRepository.findById(entitlementId);

  if (!entitlement) {
    throw entitlementNotFound();
  }

  const [dto] = await toEnrichedEntitlementDtos([entitlement as EntitlementDocument], {
    includeAttempts: true,
  });
  return dto;
}

type EntitlementDocument = {
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

async function toEnrichedEntitlementDtos(
  entitlements: EntitlementDocument[],
  options: { includeAttempts?: boolean } = {},
): Promise<EntitlementDto[]> {
  const [summaryById, attemptCountById] = await Promise.all([
    buildTestSeriesSummaryByIds(
      entitlements.map((entitlement) => entitlement.testSeriesId.toString()),
    ),
    options.includeAttempts
      ? attemptRepository.countByEntitlementIds(
          entitlements.map((entitlement) => entitlement._id.toString()),
        )
      : Promise.resolve(null),
  ]);

  return entitlements.map((entitlement) => {
    const used = attemptCountById?.get(entitlement._id.toString()) ?? 0;
    const summary = summaryById.get(entitlement.testSeriesId.toString()) ?? null;
    const unlimited = summary ? isUnlimitedAttemptPath(summary) : false;

    return toEntitlementDto(
      entitlement,
      summary,
      attemptCountById
        ? {
            used,
            max: unlimited ? null : V1_MAX_ATTEMPTS,
            remaining: unlimited ? null : Math.max(0, V1_MAX_ATTEMPTS - used),
          }
        : null,
    );
  });
}
