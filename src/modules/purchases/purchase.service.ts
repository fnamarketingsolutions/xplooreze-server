import { getConfig, requireRazorpayConfig } from '../../config/index';
import { PENDING_PURCHASE_REUSE_WINDOW_MS } from '../../database/models/conventions';
import type { PurchaseListFilter } from '../../database/repositories/access.repository';
import { purchaseRepository, testSeriesRepository } from '../../database/repositories/index';
import { createRazorpayOrder } from '../../integrations/razorpay/razorpay.orders';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';
import { findValidActiveEntitlement } from '../entitlements/entitlement.service';
import { buildTestSeriesSummaryByIds } from '../test-series/test-series-summary';
import { V1_CURRENCY } from '../test-series/test-series.validation';
import { toPurchaseDto } from './purchase.dto';
import type { CreatePurchaseCheckoutDto, PurchaseDto } from './purchase.dto';
import type { AdminPurchaseListQuery, CreatePurchaseInput } from './purchase.validation';

function purchaseNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.PURCHASE_NOT_FOUND,
    message: 'Purchase not found.',
  });
}

function purchaseAlreadyOwned(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.PURCHASE_ALREADY_OWNED,
    message: 'You already have active access to this test series.',
  });
}

function notPurchasable(message: string): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.TEST_SERIES_NOT_PURCHASABLE,
    message,
  });
}

function purchaseNotResumable(message: string): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.TEST_SERIES_NOT_PURCHASABLE,
    message,
  });
}

export function isPendingPurchaseReusable(createdAt: Date | undefined, now = new Date()): boolean {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    return false;
  }

  return now.getTime() - createdAt.getTime() < PENDING_PURCHASE_REUSE_WINDOW_MS;
}

function toCheckoutDto(purchase: {
  _id: { toString(): string };
  amount: number;
  currency: string;
  razorpayOrderId?: string | null;
}): CreatePurchaseCheckoutDto {
  const razorpay = requireRazorpayConfig(getConfig().razorpay);

  if (!purchase.razorpayOrderId) {
    throw new AppError({
      statusCode: 500,
      code: ErrorCodes.INTERNAL_SERVER_ERROR,
      message: 'Purchase is missing a Razorpay order.',
    });
  }

  return {
    purchaseId: purchase._id.toString(),
    razorpayOrderId: purchase.razorpayOrderId,
    razorpayKeyId: razorpay.keyId,
    amount: purchase.amount,
    currency: purchase.currency,
  };
}

export async function createPaidPurchase(
  studentId: string,
  input: CreatePurchaseInput,
): Promise<CreatePurchaseCheckoutDto> {
  const logger = getLogger({ module: 'purchases' });
  const testSeries = await testSeriesRepository.findById(input.testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCodes.TEST_SERIES_NOT_FOUND,
      message: 'Test series not found.',
    });
  }

  if (testSeries.status !== 'ACTIVE') {
    throw notPurchasable('Test series is not available for purchase.');
  }

  if (testSeries.type === 'MCQ' || testSeries.access.isFree) {
    throw notPurchasable('Free MCQ test series cannot be purchased through Razorpay.');
  }

  if (testSeries.type !== 'PDF' && testSeries.type !== 'EDITOR') {
    throw notPurchasable('Test series type is not purchasable.');
  }

  if (
    !Number.isInteger(testSeries.access.price) ||
    testSeries.access.price <= 0 ||
    testSeries.access.currency !== V1_CURRENCY
  ) {
    throw notPurchasable('Test series does not have a valid purchase price.');
  }

  const existingAccess = await findValidActiveEntitlement(studentId, input.testSeriesId);
  if (existingAccess) {
    throw purchaseAlreadyOwned();
  }

  const pending = await purchaseRepository.findPendingByStudentAndTestSeries(
    studentId,
    input.testSeriesId,
  );

  if (pending?.razorpayOrderId && isPendingPurchaseReusable(pending.createdAt)) {
    logger.info(
      {
        event: 'PURCHASE_PENDING_REUSED',
        purchaseId: pending._id.toString(),
        testSeriesId: input.testSeriesId,
      },
      'Reusing existing pending purchase',
    );
    return toCheckoutDto(pending);
  }

  const amount = testSeries.access.price;
  const currency = V1_CURRENCY;

  const purchase = await purchaseRepository.create({
    studentId,
    testSeriesId: input.testSeriesId,
    amount,
    currency,
    status: 'PENDING',
  });

  logger.info(
    {
      event: 'PURCHASE_CREATED',
      purchaseId: purchase._id.toString(),
      testSeriesId: input.testSeriesId,
      amount,
      currency,
    },
    'Purchase created',
  );

  try {
    const order = await createRazorpayOrder({
      amount,
      currency,
      receipt: purchase._id.toString().slice(0, 40),
      notes: {
        purchaseId: purchase._id.toString(),
        testSeriesId: input.testSeriesId,
        studentId,
      },
    });

    const updated = await purchaseRepository.updateById(purchase._id, {
      $set: { razorpayOrderId: order.id },
    });

    if (!updated) {
      throw purchaseNotFound();
    }

    logger.info(
      {
        event: 'RAZORPAY_ORDER_CREATED',
        purchaseId: purchase._id.toString(),
        razorpayOrderId: order.id,
      },
      'Razorpay order created',
    );

    return toCheckoutDto(updated);
  } catch (error) {
    await purchaseRepository.updateById(purchase._id, {
      $set: { status: 'FAILED' },
    });

    logger.warn(
      {
        event: 'PAYMENT_FAILED',
        purchaseId: purchase._id.toString(),
        reason: 'RAZORPAY_ORDER_CREATE_FAILED',
      },
      'Razorpay order creation failed; purchase marked FAILED',
    );

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError({
      statusCode: 502,
      code: ErrorCodes.PAYMENT_VERIFICATION_FAILED,
      message: 'Unable to create payment order.',
    });
  }
}

type PurchaseDocument = {
  _id: { toString(): string };
  studentId: { toString(): string };
  testSeriesId: { toString(): string };
  amount: number;
  currency: string;
  status: string;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

async function toEnrichedPurchaseDtos(purchases: PurchaseDocument[]): Promise<PurchaseDto[]> {
  const summaryById = await buildTestSeriesSummaryByIds(
    purchases.map((purchase) => purchase.testSeriesId.toString()),
  );
  return purchases.map((purchase) =>
    toPurchaseDto(purchase, summaryById.get(purchase.testSeriesId.toString()) ?? null),
  );
}

export async function listStudentPurchases(studentId: string, pagination: PaginationInput) {
  const filter = { studentId };
  const [items, total] = await Promise.all([
    purchaseRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { createdAt: -1 },
    }),
    purchaseRepository.count(filter),
  ]);

  return {
    items: await toEnrichedPurchaseDtos(items as PurchaseDocument[]),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getStudentPurchase(studentId: string, purchaseId: string) {
  const purchase = await purchaseRepository.findById(purchaseId);

  if (!purchase || purchase.studentId.toString() !== studentId) {
    throw purchaseNotFound();
  }

  const [dto] = await toEnrichedPurchaseDtos([purchase as PurchaseDocument]);
  return dto;
}

export async function getStudentPendingPurchaseCheckout(
  studentId: string,
  purchaseId: string,
): Promise<CreatePurchaseCheckoutDto> {
  const purchase = await purchaseRepository.findById(purchaseId);

  if (!purchase || purchase.studentId.toString() !== studentId) {
    throw purchaseNotFound();
  }

  if (purchase.status !== 'PENDING') {
    throw purchaseNotResumable('Purchase is not pending and cannot be resumed.');
  }

  if (!isPendingPurchaseReusable(purchase.createdAt)) {
    throw purchaseNotResumable(
      'Pending purchase reuse window has expired. Start a new purchase instead.',
    );
  }

  if (!purchase.razorpayOrderId) {
    throw purchaseNotResumable('Purchase is missing a payment order and cannot be resumed.');
  }

  const existingAccess = await findValidActiveEntitlement(
    studentId,
    purchase.testSeriesId.toString(),
  );
  if (existingAccess) {
    throw purchaseAlreadyOwned();
  }

  return toCheckoutDto(purchase);
}

function toAdminPurchaseFilter(query: AdminPurchaseListQuery): PurchaseListFilter {
  const createdAt = {
    ...(query.createdFrom ? { $gte: query.createdFrom } : {}),
    ...(query.createdTo ? { $lte: query.createdTo } : {}),
  };

  return {
    ...(query.studentId ? { studentId: query.studentId } : {}),
    ...(query.testSeriesId ? { testSeriesId: query.testSeriesId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
  };
}

export async function listAdminPurchases(
  pagination: PaginationInput,
  query: AdminPurchaseListQuery = {},
) {
  const filter = toAdminPurchaseFilter(query);
  const [items, total] = await Promise.all([
    purchaseRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { createdAt: -1 },
    }),
    purchaseRepository.count(filter),
  ]);

  return {
    items: await toEnrichedPurchaseDtos(items as PurchaseDocument[]),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getAdminPurchase(purchaseId: string) {
  const purchase = await purchaseRepository.findById(purchaseId);

  if (!purchase) {
    throw purchaseNotFound();
  }

  const [dto] = await toEnrichedPurchaseDtos([purchase as PurchaseDocument]);
  return dto;
}
