import type { ClientSession } from 'mongoose';

import { mapPersistenceError, remapDuplicateKey } from '../../database/errors';
import { withTransaction } from '../../database/transactions';
import {
  entitlementRepository,
  purchaseRepository,
  webhookEventRepository,
} from '../../database/repositories/index';
import { fetchRazorpayPayment } from '../../integrations/razorpay/razorpay.orders';
import {
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../../integrations/razorpay/razorpay.signatures';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';
import {
  createPaidEntitlement,
  findValidActiveEntitlement,
  isEntitlementUnexpired,
} from '../entitlements/entitlement.service';
import { toEntitlementDto } from '../entitlements/entitlement.dto';
import { notifyPurchaseSuccessful } from '../notifications/notification.service';
import { toPurchaseDto } from '../purchases/purchase.dto';

export type VerifyPaymentInput = {
  purchaseId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
};

function purchaseNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.PURCHASE_NOT_FOUND,
    message: 'Purchase not found.',
  });
}

function invalidSignature(): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.INVALID_PAYMENT_SIGNATURE,
    message: 'Payment signature is invalid.',
  });
}

async function loadOwnedPendingOrPaidPurchase(studentId: string, purchaseId: string) {
  const purchase = await purchaseRepository.findById(purchaseId);

  if (!purchase || purchase.studentId.toString() !== studentId) {
    throw purchaseNotFound();
  }

  return purchase;
}

async function grantAccessForPaidPurchase(
  purchase: {
    _id: { toString(): string };
    studentId: { toString(): string };
    testSeriesId: { toString(): string };
    status: string;
    amount: number;
    currency: string;
    razorpayOrderId?: string | null;
    razorpayPaymentId?: string | null;
  },
  razorpayPaymentId: string,
  session: ClientSession,
) {
  const purchaseId = purchase._id.toString();

  if (purchase.status === 'PAID') {
    const existing =
      (await entitlementRepository.findByPurchaseId(purchaseId, { session })) ??
      (await entitlementRepository.findActiveByStudentAndTestSeries(
        purchase.studentId.toString(),
        purchase.testSeriesId.toString(),
        { session },
      ));

    return {
      purchase,
      entitlement: existing,
      newlyPaid: false,
    };
  }

  if (purchase.status === 'FAILED') {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.PAYMENT_VERIFICATION_FAILED,
      message: 'Purchase is in a failed state.',
    });
  }

  if (purchase.status !== 'PENDING') {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.PAYMENT_VERIFICATION_FAILED,
      message: 'Purchase cannot be marked paid from its current state.',
    });
  }

  const updated = await purchaseRepository.updateById(
    purchaseId,
    {
      $set: {
        status: 'PAID',
        razorpayPaymentId,
      },
    },
    { session },
  );

  if (!updated) {
    throw purchaseNotFound();
  }

  const grantedAt = new Date();

  try {
    const entitlement = await createPaidEntitlement({
      studentId: purchase.studentId.toString(),
      testSeriesId: purchase.testSeriesId.toString(),
      purchaseId,
      grantedAt,
      session,
    });

    return { purchase: updated, entitlement, newlyPaid: true };
  } catch {
    // Normalize a stale ACTIVE-but-expired entitlement, then retry once.
    await findValidActiveEntitlement(
      purchase.studentId.toString(),
      purchase.testSeriesId.toString(),
      new Date(),
      session,
    );

    try {
      const entitlement = await createPaidEntitlement({
        studentId: purchase.studentId.toString(),
        testSeriesId: purchase.testSeriesId.toString(),
        purchaseId,
        grantedAt,
        session,
      });
      return { purchase: updated, entitlement, newlyPaid: true };
    } catch (retryError) {
      const existingActive = await entitlementRepository.findActiveByStudentAndTestSeries(
        purchase.studentId.toString(),
        purchase.testSeriesId.toString(),
        { session },
      );

      if (existingActive && isEntitlementUnexpired(existingActive)) {
        return { purchase: updated, entitlement: existingActive, newlyPaid: true };
      }

      const mapped = mapPersistenceError(retryError);
      if (mapped?.code === ErrorCodes.DUPLICATE_KEY) {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.ACTIVE_ENTITLEMENT_EXISTS,
          message: 'An active entitlement already exists for this test series.',
        });
      }

      throw retryError;
    }
  }
}

export async function markPurchasePaidAndGrantEntitlement(input: {
  purchaseId: string;
  razorpayPaymentId: string;
  expectedOrderId: string;
  expectedAmount?: number;
  expectedCurrency?: string;
}) {
  return withTransaction(async (session) => {
    const purchase = await purchaseRepository.findById(input.purchaseId, { session });

    if (!purchase) {
      throw purchaseNotFound();
    }

    if (purchase.razorpayOrderId !== input.expectedOrderId) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCodes.PAYMENT_ORDER_MISMATCH,
        message: 'Payment order does not match the purchase.',
      });
    }

    if (input.expectedAmount !== undefined && purchase.amount !== input.expectedAmount) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCodes.PAYMENT_AMOUNT_MISMATCH,
        message: 'Payment amount does not match the purchase.',
      });
    }

    if (input.expectedCurrency !== undefined && purchase.currency !== input.expectedCurrency) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCodes.PAYMENT_AMOUNT_MISMATCH,
        message: 'Payment currency does not match the purchase.',
      });
    }

    return grantAccessForPaidPurchase(purchase, input.razorpayPaymentId, session);
  });
}

async function notifyPurchaseSuccessfulIfNewlyPaid(result: {
  newlyPaid: boolean;
  entitlement?: { _id?: { toString(): string } } | null;
  purchase: {
    _id: { toString(): string };
    studentId: { toString(): string };
    testSeriesId: { toString(): string };
    amount: number;
    currency: string;
  };
}) {
  if (!result.newlyPaid || !result.entitlement) {
    return;
  }

  await notifyPurchaseSuccessful({
    studentId: result.purchase.studentId.toString(),
    testSeriesId: result.purchase.testSeriesId.toString(),
    purchaseId: result.purchase._id.toString(),
    amount: result.purchase.amount,
    currency: result.purchase.currency,
  });
}

export async function verifyStudentPayment(studentId: string, input: VerifyPaymentInput) {
  const logger = getLogger({ module: 'payments' });

  logger.info(
    {
      event: 'PAYMENT_VERIFICATION_STARTED',
      purchaseId: input.purchaseId,
    },
    'Payment verification started',
  );

  const purchase = await loadOwnedPendingOrPaidPurchase(studentId, input.purchaseId);

  if (purchase.razorpayOrderId !== input.razorpayOrderId) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.PAYMENT_ORDER_MISMATCH,
      message: 'Payment order does not match the purchase.',
    });
  }

  const signatureValid = verifyPaymentSignature({
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
  });

  if (!signatureValid) {
    throw invalidSignature();
  }

  if (purchase.status === 'PAID') {
    const entitlement =
      (await entitlementRepository.findByPurchaseId(purchase._id)) ??
      (await findValidActiveEntitlement(
        purchase.studentId.toString(),
        purchase.testSeriesId.toString(),
      ));

    logger.info(
      {
        event: 'PAYMENT_ALREADY_PROCESSED',
        purchaseId: purchase._id.toString(),
      },
      'Payment already processed',
    );

    return {
      purchase: toPurchaseDto(purchase),
      entitlement: entitlement ? toEntitlementDto(entitlement) : null,
    };
  }

  let providerPayment;
  try {
    providerPayment = await fetchRazorpayPayment(input.razorpayPaymentId);
  } catch {
    throw new AppError({
      statusCode: 502,
      code: ErrorCodes.PAYMENT_VERIFICATION_FAILED,
      message: 'Unable to verify payment with provider.',
    });
  }

  if (providerPayment.order_id !== input.razorpayOrderId) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.PAYMENT_ORDER_MISMATCH,
      message: 'Payment order does not match the purchase.',
    });
  }

  if (
    providerPayment.amount !== purchase.amount ||
    providerPayment.currency !== purchase.currency
  ) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.PAYMENT_AMOUNT_MISMATCH,
      message: 'Payment amount does not match the purchase.',
    });
  }

  if (providerPayment.status !== 'captured' && providerPayment.status !== 'authorized') {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.PAYMENT_NOT_CAPTURED,
      message: 'Payment has not been captured.',
    });
  }

  const result = await markPurchasePaidAndGrantEntitlement({
    purchaseId: purchase._id.toString(),
    razorpayPaymentId: input.razorpayPaymentId,
    expectedOrderId: input.razorpayOrderId,
    expectedAmount: purchase.amount,
    expectedCurrency: purchase.currency,
  });

  logger.info(
    {
      event: 'PAYMENT_VERIFIED',
      purchaseId: purchase._id.toString(),
      entitlementId: result.entitlement?._id?.toString(),
    },
    'Payment verified',
  );

  if (result.entitlement) {
    logger.info(
      {
        event: 'ENTITLEMENT_CREATED',
        purchaseId: purchase._id.toString(),
        entitlementId: result.entitlement._id.toString(),
      },
      'Entitlement created',
    );
  }

  await notifyPurchaseSuccessfulIfNewlyPaid(result);

  return {
    purchase: toPurchaseDto(result.purchase),
    entitlement: result.entitlement ? toEntitlementDto(result.entitlement) : null,
  };
}

export async function markPurchaseFailed(purchaseId: string) {
  const purchase = await purchaseRepository.findById(purchaseId);

  if (!purchase) {
    throw purchaseNotFound();
  }

  if (purchase.status === 'PAID') {
    return toPurchaseDto(purchase);
  }

  if (purchase.status === 'FAILED') {
    return toPurchaseDto(purchase);
  }

  const updated = await purchaseRepository.updateById(purchaseId, {
    $set: { status: 'FAILED' },
  });

  if (!updated) {
    throw purchaseNotFound();
  }

  getLogger({ module: 'payments' }).info(
    {
      event: 'PAYMENT_FAILED',
      purchaseId,
    },
    'Purchase marked FAILED',
  );

  return toPurchaseDto(updated);
}

type RazorpayWebhookPayload = {
  event?: string;
  id?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
      };
    };
  };
};

async function claimWebhookEvent(eventId: string, eventType: string) {
  const existing = await webhookEventRepository.findByProviderAndEventId('RAZORPAY', eventId);

  if (existing?.processedAt) {
    return { duplicate: true as const, event: existing };
  }

  if (existing) {
    return { duplicate: false as const, event: existing };
  }

  try {
    const created = await webhookEventRepository.create({
      provider: 'RAZORPAY',
      eventId,
      eventType,
      processedAt: null,
    });
    return { duplicate: false as const, event: created };
  } catch (error) {
    remapDuplicateKey(
      error,
      new AppError({
        statusCode: 409,
        code: ErrorCodes.DUPLICATE_KEY,
        message: 'Webhook event already recorded.',
      }),
    );
  }
}

async function markWebhookProcessed(eventId: string) {
  const event = await webhookEventRepository.findByProviderAndEventId('RAZORPAY', eventId);
  if (!event) {
    return;
  }

  await webhookEventRepository.updateById(event._id, {
    $set: { processedAt: new Date() },
  });
}

export async function processRazorpayWebhook(input: {
  rawBody: Buffer | string;
  signature: string | undefined;
  eventId?: string;
}) {
  const logger = getLogger({ module: 'payments' });

  if (!input.signature) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
      message: 'Webhook signature is missing.',
    });
  }

  const valid = verifyWebhookSignature({
    rawBody: input.rawBody,
    signature: input.signature,
  });

  if (!valid) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
      message: 'Webhook signature is invalid.',
    });
  }

  const raw = typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8');
  let payload: RazorpayWebhookPayload;

  try {
    payload = JSON.parse(raw) as RazorpayWebhookPayload;
  } catch {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Webhook payload is invalid.',
    });
  }

  const eventType = payload.event;
  const eventId = input.eventId?.trim() || payload.id;

  if (!eventType || !eventId) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Webhook event identifiers are required.',
    });
  }

  logger.info(
    {
      event: 'PAYMENT_WEBHOOK_RECEIVED',
      eventType,
      eventId,
    },
    'Razorpay webhook received',
  );

  let claim;
  try {
    claim = await claimWebhookEvent(eventId, eventType);
  } catch (error) {
    if (error instanceof AppError && error.code === ErrorCodes.DUPLICATE_KEY) {
      const existing = await webhookEventRepository.findByProviderAndEventId('RAZORPAY', eventId);
      if (existing?.processedAt) {
        logger.info(
          {
            event: 'PAYMENT_WEBHOOK_DUPLICATE',
            eventId,
          },
          'Duplicate webhook ignored',
        );
        return { processed: true, duplicate: true };
      }
      claim = { duplicate: false as const, event: existing! };
    } else {
      throw error;
    }
  }

  if (claim.duplicate) {
    logger.info(
      {
        event: 'PAYMENT_WEBHOOK_DUPLICATE',
        eventId,
      },
      'Duplicate webhook ignored',
    );
    return { processed: true, duplicate: true };
  }

  try {
    if (eventType === 'payment.captured') {
      const payment = payload.payload?.payment?.entity;
      if (!payment?.id || !payment.order_id) {
        throw new AppError({
          statusCode: 400,
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Webhook payment identifiers are required.',
        });
      }

      const purchase = await purchaseRepository.findByRazorpayOrderId(payment.order_id);

      if (!purchase) {
        logger.warn(
          {
            event: 'PAYMENT_RECONCILIATION_FAILED',
            razorpayOrderId: payment.order_id,
            razorpayPaymentId: payment.id,
          },
          'Webhook references unknown purchase',
        );
      } else {
        await notifyPurchaseSuccessfulIfNewlyPaid(
          await markPurchasePaidAndGrantEntitlement({
            purchaseId: purchase._id.toString(),
            razorpayPaymentId: payment.id,
            expectedOrderId: payment.order_id,
            expectedAmount: payment.amount,
            expectedCurrency: payment.currency,
          }),
        );
      }
    } else if (eventType === 'payment.failed') {
      const payment = payload.payload?.payment?.entity;
      if (payment?.order_id) {
        const purchase = await purchaseRepository.findByRazorpayOrderId(payment.order_id);
        if (purchase && purchase.status === 'PENDING') {
          await markPurchaseFailed(purchase._id.toString());
        }
      }
    } else if (eventType === 'refund.processed') {
      // Provider-level refund events are acknowledged for webhook idempotency only.
      // They must not mutate Purchase, revoke entitlement, or create a refund record.
      logger.info(
        {
          eventType,
          eventId,
        },
        'Provider refund event acknowledged without product-state mutation',
      );
    }

    await markWebhookProcessed(eventId);

    logger.info(
      {
        event: 'PAYMENT_WEBHOOK_PROCESSED',
        eventId,
        eventType,
      },
      'Razorpay webhook processed',
    );

    return { processed: true, duplicate: false };
  } catch (error) {
    logger.warn(
      {
        event: 'PAYMENT_WEBHOOK_FAILED',
        eventId,
        eventType,
      },
      'Razorpay webhook processing failed',
    );
    throw error;
  }
}
