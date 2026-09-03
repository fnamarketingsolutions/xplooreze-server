import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resetConfigForTests } from '../src/config/index';
import { STALE_PENDING_PURCHASE_MS } from '../src/database/models/conventions';
import { PurchaseModel } from '../src/database/models/purchase.model';
import { runPurchaseCleanup } from '../src/modules/purchases/purchase-cleanup.service';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';

async function backdatePurchaseCreatedAt(purchaseId: string, createdAt: Date): Promise<void> {
  const result = await PurchaseModel.collection.updateOne(
    { _id: new Types.ObjectId(purchaseId) },
    { $set: { createdAt } },
  );
  expect(result.modifiedCount).toBe(1);
}

describe('Purchase cleanup', () => {
  beforeAll(async () => {
    await startMemoryMongo();
  });

  afterAll(async () => {
    await stopMemoryMongo();
  });

  beforeEach(() => {
    resetConfigForTests();
    process.env.JWT_SECRET = TEST_SECRET;
    loadConfig();
    resetLoggerForTests();
  });

  afterEach(async () => {
    await clearMemoryMongo();
  });

  it('marks PENDING purchases older than 7 days as FAILED', async () => {
    const now = new Date();
    const studentId = new Types.ObjectId();
    const testSeriesId = new Types.ObjectId();

    const stale = await PurchaseModel.create({
      studentId,
      testSeriesId,
      amount: 49900,
      currency: 'INR',
      status: 'PENDING',
      razorpayOrderId: 'order_stale_cleanup',
    });
    await backdatePurchaseCreatedAt(
      stale._id.toString(),
      new Date(now.getTime() - STALE_PENDING_PURCHASE_MS - 1),
    );

    const fresh = await PurchaseModel.create({
      studentId,
      testSeriesId: new Types.ObjectId(),
      amount: 49900,
      currency: 'INR',
      status: 'PENDING',
      razorpayOrderId: 'order_fresh_cleanup',
    });

    const summary = await runPurchaseCleanup(now);

    expect(summary.stalePendingFailed).toBe(1);
    expect((await PurchaseModel.findById(stale._id))?.status).toBe('FAILED');
    expect((await PurchaseModel.findById(fresh._id))?.status).toBe('PENDING');
  });

  it('does not mutate PAID or already FAILED purchases', async () => {
    const now = new Date();
    const studentId = new Types.ObjectId();
    const testSeriesId = new Types.ObjectId();
    const createdAt = new Date(now.getTime() - STALE_PENDING_PURCHASE_MS - 1);

    const paid = await PurchaseModel.create({
      studentId,
      testSeriesId,
      amount: 49900,
      currency: 'INR',
      status: 'PAID',
      razorpayOrderId: 'order_paid_cleanup',
      razorpayPaymentId: 'pay_paid_cleanup',
    });
    await backdatePurchaseCreatedAt(paid._id.toString(), createdAt);

    const failed = await PurchaseModel.create({
      studentId,
      testSeriesId: new Types.ObjectId(),
      amount: 49900,
      currency: 'INR',
      status: 'FAILED',
      razorpayOrderId: 'order_failed_cleanup',
    });
    await backdatePurchaseCreatedAt(failed._id.toString(), createdAt);

    const summary = await runPurchaseCleanup(now);

    expect(summary.stalePendingFailed).toBe(0);
    expect((await PurchaseModel.findById(paid._id))?.status).toBe('PAID');
    expect((await PurchaseModel.findById(failed._id))?.status).toBe('FAILED');
  });

  it('is idempotent when rerun on the same stale purchase', async () => {
    const now = new Date();
    const purchase = await PurchaseModel.create({
      studentId: new Types.ObjectId(),
      testSeriesId: new Types.ObjectId(),
      amount: 49900,
      currency: 'INR',
      status: 'PENDING',
      razorpayOrderId: 'order_idempotent_cleanup',
    });
    await backdatePurchaseCreatedAt(
      purchase._id.toString(),
      new Date(now.getTime() - STALE_PENDING_PURCHASE_MS - 1),
    );

    const first = await runPurchaseCleanup(now);
    const second = await runPurchaseCleanup(now);

    expect(first.stalePendingFailed).toBe(1);
    expect(second.stalePendingFailed).toBe(0);
    expect((await PurchaseModel.findById(purchase._id))?.status).toBe('FAILED');
  });
});
