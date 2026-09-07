import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { PENDING_PURCHASE_REUSE_WINDOW_MS } from '../src/database/models/conventions';
import { CategoryModel } from '../src/database/models/category.model';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { HttpIdempotencyKeyModel } from '../src/database/models/http-idempotency-key.model';
import { ModuleModel } from '../src/database/models/module.model';
import { PurchaseModel } from '../src/database/models/purchase.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { WebhookEventModel } from '../src/database/models/webhook-event.model';
import { userRepository } from '../src/database/repositories/user.repository';
import {
  resetRazorpayClientForTests,
  signPaymentVerification,
  signWebhookPayload,
} from '../src/integrations/razorpay/index';
import { hashPassword } from '../src/modules/auth/password';
import { IDEMPOTENCY_OPERATIONS } from '../src/shared/http/idempotency';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const RAZORPAY_KEY_ID = 'rzp_test_key';
const RAZORPAY_KEY_SECRET = 'rzp_test_secret';
const RAZORPAY_WEBHOOK_SECRET = 'whsec_test_secret';
const PRICE_PAISE = 49900;

type App = ReturnType<typeof createApp>;

const createOrderMock = vi.fn();
const fetchPaymentMock = vi.fn();

vi.mock('razorpay', () => {
  return {
    default: class MockRazorpay {
      orders = {
        create: (...args: unknown[]) => createOrderMock(...args),
      };
      payments = {
        fetch: (...args: unknown[]) => fetchPaymentMock(...args),
      };

      constructor(_config: unknown) {
        // no-op
      }
    },
  };
});

async function seedUsers(): Promise<void> {
  await userRepository.create({
    email: 'student@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'STUDENT',
    status: 'ACTIVE',
    name: { first: 'Stu', last: 'Dent' },
  });
  await userRepository.create({
    email: 'student2@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'STUDENT',
    status: 'ACTIVE',
    name: { first: 'Other', last: 'Student' },
  });
  await userRepository.create({
    email: 'admin@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'ADMIN',
    status: 'ACTIVE',
    name: { first: 'Ada', last: 'Min' },
  });
}

async function login(app: App, email: string): Promise<string> {
  const response = await request(app).post('/auth/login').send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.body.data.accessToken as string;
}

function bearer(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-exam-session-id': '11111111-1111-4111-8111-111111111111',
  };
}

function purchaseHeaders(token: string, key: string) {
  return { ...bearer(token), 'Idempotency-Key': key };
}

async function backdatePurchaseCreatedAt(purchaseId: string, createdAt: Date): Promise<void> {
  const result = await PurchaseModel.collection.updateOne(
    { _id: new Types.ObjectId(purchaseId) },
    { $set: { createdAt } },
  );
  expect(result.modifiedCount).toBe(1);
}

async function seedPaidCatalog(app: App) {
  const adminToken = await login(app, 'admin@example.com');
  const category = await request(app)
    .post('/admin/categories')
    .set(bearer(adminToken))
    .send({ name: 'Mathematics' });
  const module = await request(app)
    .post('/admin/modules')
    .set(bearer(adminToken))
    .send({ categoryId: category.body.data.id, name: 'Algebra' });
  const pdf = await request(app)
    .post('/admin/test-series')
    .set(bearer(adminToken))
    .send({
      moduleId: module.body.data.id,
      title: 'PDF Series',
      type: 'PDF',
      duration: 3600,
      access: { isFree: false, price: PRICE_PAISE, currency: 'INR' },
    });
  const editor = await request(app)
    .post('/admin/test-series')
    .set(bearer(adminToken))
    .send({
      moduleId: module.body.data.id,
      title: 'Editor Series',
      type: 'EDITOR',
      duration: 3600,
      access: { isFree: false, price: 99900, currency: 'INR' },
    });

  return {
    pdf: pdf.body.data as { id: string },
    editor: editor.body.data as { id: string },
  };
}

describe('Phase 22 HTTP idempotency and PENDING purchase expiration', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await ModuleModel.createIndexes();
    await TestSeriesModel.createIndexes();
    await PurchaseModel.createIndexes();
    await EntitlementModel.createIndexes();
    await WebhookEventModel.createIndexes();
    await HttpIdempotencyKeyModel.createIndexes();
  }, 120_000);

  afterAll(async () => {
    await stopMemoryMongo();
  });

  beforeEach(async () => {
    resetConfigForTests();
    resetRazorpayClientForTests();
    resetLoggerForTests();
    createOrderMock.mockReset();
    fetchPaymentMock.mockReset();
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: TEST_SECRET,
      RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET,
    });
    await seedUsers();
  });

  afterEach(async () => {
    await clearMemoryMongo();
  });

  describe('Idempotency-Key on purchase initiation', () => {
    it('requires a valid Idempotency-Key after authentication', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedPaidCatalog(app);

      const missing = await request(app)
        .post('/purchases')
        .set(bearer(studentToken))
        .send({ testSeriesId: pdf.id });
      const empty = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, ''))
        .send({ testSeriesId: pdf.id });
      const tooLong = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, 'k'.repeat(129)))
        .send({ testSeriesId: pdf.id });

      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(empty.status).toBe(400);
      expect(tooLong.status).toBe(400);
      expect(createOrderMock).not.toHaveBeenCalled();
    });

    it('does not require Idempotency-Key on verify, webhook, or purchase reads', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedPaidCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_optional_surfaces',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, randomUUID()))
        .send({ testSeriesId: pdf.id });
      expect(checkout.status).toBe(201);

      const listed = await request(app).get('/me/purchases').set(bearer(studentToken));
      expect(listed.status).toBe(200);

      const verify = await request(app).post('/payments/verify').set(bearer(studentToken)).send({
        purchaseId: checkout.body.data.purchaseId,
        razorpayOrderId: checkout.body.data.razorpayOrderId,
        razorpayPaymentId: 'pay_missing_header',
        razorpaySignature: 'not-verified-here',
      });
      expect(verify.status).toBe(400);
      expect(verify.body.error.code).toBe(ErrorCodes.INVALID_PAYMENT_SIGNATURE);

      const webhookPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'payment.failed',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_no_http_key',
              order_id: 'order_optional_surfaces',
              amount: PRICE_PAISE,
              currency: 'INR',
              status: 'failed',
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      });
      const webhook = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_no_http_key')
        .set('X-Razorpay-Signature', signWebhookPayload(webhookPayload, RAZORPAY_WEBHOOK_SECRET))
        .send(webhookPayload);
      expect(webhook.status).toBe(200);
    });

    it('replays the same purchase result without a second Razorpay order or Purchase', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedPaidCatalog(app);
      const key = randomUUID();

      createOrderMock.mockResolvedValue({
        id: 'order_replay',
        amount: PRICE_PAISE,
        currency: 'INR',
      });

      const first = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, key))
        .send({ testSeriesId: pdf.id });
      const second = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, key))
        .send({ testSeriesId: pdf.id });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data).toEqual(first.body.data);
      expect(createOrderMock).toHaveBeenCalledTimes(1);
      expect(await PurchaseModel.countDocuments({})).toBe(1);
      expect(await HttpIdempotencyKeyModel.countDocuments({})).toBe(1);

      const stored = await HttpIdempotencyKeyModel.findOne({ key }).lean();
      const serialized = JSON.stringify(stored);
      expect(stored?.userId.toString()).toBe(
        (await userRepository.findByEmail('student@example.com'))!._id.toString(),
      );
      expect(stored?.operation).toBe(IDEMPOTENCY_OPERATIONS.PURCHASES_CREATE);
      expect(stored?.status).toBe('COMPLETED');
      expect(stored?.response).toEqual({
        type: 'success',
        data: first.body.data,
      });
      expect(serialized).not.toContain(studentToken);
      expect(serialized).not.toContain(RAZORPAY_KEY_SECRET);
      expect(serialized).not.toContain(RAZORPAY_WEBHOOK_SECRET);
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Bearer');
    });

    it('rejects the same key for a different purchase request', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf, editor } = await seedPaidCatalog(app);
      const key = randomUUID();

      createOrderMock.mockResolvedValue({
        id: 'order_conflict',
        amount: PRICE_PAISE,
        currency: 'INR',
      });

      const first = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, key))
        .send({ testSeriesId: pdf.id });
      const conflict = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, key))
        .send({ testSeriesId: editor.id });

      expect(first.status).toBe(201);
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe(ErrorCodes.IDEMPOTENCY_KEY_REUSED);
      expect(conflict.body.error).not.toHaveProperty('requestHash');
      expect(createOrderMock).toHaveBeenCalledTimes(1);
      expect(await PurchaseModel.countDocuments({})).toBe(1);
    });

    it('scopes keys to the authenticated user and server-defined operation', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const otherToken = await login(app, 'student2@example.com');
      const { pdf } = await seedPaidCatalog(app);
      const key = 'shared-client-key';
      const student = await userRepository.findByEmail('student@example.com');

      createOrderMock
        .mockResolvedValueOnce({ id: 'order_user_a', amount: PRICE_PAISE, currency: 'INR' })
        .mockResolvedValueOnce({ id: 'order_user_b', amount: PRICE_PAISE, currency: 'INR' });

      await HttpIdempotencyKeyModel.create({
        userId: student!._id,
        operation: 'POST /other',
        key,
        requestHash: 'deadbeef',
        status: 'COMPLETED',
        httpStatus: 201,
        response: { type: 'success', data: { other: true } },
        expiresAt: new Date(Date.now() + 60_000),
      });

      const firstUser = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, key))
        .send({ testSeriesId: pdf.id });
      const secondUser = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(otherToken, key))
        .send({ testSeriesId: pdf.id });

      expect(firstUser.status).toBe(201);
      expect(secondUser.status).toBe(201);
      expect(firstUser.body.data.purchaseId).not.toBe(secondUser.body.data.purchaseId);
      expect(createOrderMock).toHaveBeenCalledTimes(2);
      expect(await PurchaseModel.countDocuments({})).toBe(2);
      expect(await HttpIdempotencyKeyModel.countDocuments({ key })).toBe(3);
    });

    it('converges concurrent identical requests onto one Purchase and Razorpay order', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedPaidCatalog(app);
      const key = randomUUID();

      createOrderMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ id: 'order_concurrent', amount: PRICE_PAISE, currency: 'INR' });
            }, 50);
          }),
      );

      const [first, second] = await Promise.all([
        request(app)
          .post('/purchases')
          .set(purchaseHeaders(studentToken, key))
          .send({ testSeriesId: pdf.id }),
        request(app)
          .post('/purchases')
          .set(purchaseHeaders(studentToken, key))
          .send({ testSeriesId: pdf.id }),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.purchaseId).toBe(first.body.data.purchaseId);
      expect(createOrderMock).toHaveBeenCalledTimes(1);
      expect(await PurchaseModel.countDocuments({})).toBe(1);
      expect(await HttpIdempotencyKeyModel.countDocuments({ key })).toBe(1);
    });

    it('does not poison a key after a transient Razorpay failure', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedPaidCatalog(app);
      const key = randomUUID();

      createOrderMock.mockRejectedValueOnce(new Error('provider down')).mockResolvedValue({
        id: 'order_after_failure',
        amount: PRICE_PAISE,
        currency: 'INR',
      });

      const failed = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, key))
        .send({ testSeriesId: pdf.id });
      const retried = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, key))
        .send({ testSeriesId: pdf.id });

      expect(failed.status).toBe(502);
      expect(retried.status).toBe(201);
      expect(retried.body.data.razorpayOrderId).toBe('order_after_failure');
      expect(await PurchaseModel.countDocuments({ status: 'FAILED' })).toBe(1);
      expect(await PurchaseModel.countDocuments({ status: 'PENDING' })).toBe(1);
      expect(await HttpIdempotencyKeyModel.countDocuments({ key, status: 'PROCESSING' })).toBe(0);
    });

    it('rejects a second insert for the same user, operation, and key', async () => {
      const student = await userRepository.findByEmail('student@example.com');
      const doc = {
        userId: student!._id,
        operation: IDEMPOTENCY_OPERATIONS.PURCHASES_CREATE,
        key: 'unique-index-key',
        requestHash: 'abc',
        status: 'PROCESSING' as const,
        expiresAt: new Date(Date.now() + 60_000),
      };

      await HttpIdempotencyKeyModel.create(doc);
      await expect(HttpIdempotencyKeyModel.create(doc)).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('PENDING purchase expiration', () => {
    it('reuses a PENDING purchase younger than 30 minutes', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedPaidCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_fresh_pending',
        amount: PRICE_PAISE,
        currency: 'INR',
      });

      const first = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, randomUUID()))
        .send({ testSeriesId: pdf.id });
      const second = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, randomUUID()))
        .send({ testSeriesId: pdf.id });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.purchaseId).toBe(first.body.data.purchaseId);
      expect(createOrderMock).toHaveBeenCalledTimes(1);
      expect(await PurchaseModel.countDocuments({})).toBe(1);
    });

    it('does not reuse a PENDING purchase at or after 30 minutes and leaves it historically PENDING', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedPaidCatalog(app);

      createOrderMock
        .mockResolvedValueOnce({
          id: 'order_stale',
          amount: PRICE_PAISE,
          currency: 'INR',
        })
        .mockResolvedValueOnce({
          id: 'order_fresh',
          amount: PRICE_PAISE,
          currency: 'INR',
        });

      const first = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, randomUUID()))
        .send({ testSeriesId: pdf.id });

      await backdatePurchaseCreatedAt(
        first.body.data.purchaseId,
        new Date(Date.now() - PENDING_PURCHASE_REUSE_WINDOW_MS),
      );

      const second = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, randomUUID()))
        .send({ testSeriesId: pdf.id });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.purchaseId).not.toBe(first.body.data.purchaseId);
      expect(second.body.data.razorpayOrderId).toBe('order_fresh');
      expect(createOrderMock).toHaveBeenCalledTimes(2);

      const stale = await PurchaseModel.findById(first.body.data.purchaseId);
      const fresh = await PurchaseModel.findById(second.body.data.purchaseId);
      expect(stale?.status).toBe('PENDING');
      expect(fresh?.status).toBe('PENDING');
      expect(stale?.status).not.toBe('EXPIRED');
      expect(await PurchaseModel.countDocuments({})).toBe(2);
    });

    it('still accepts a legitimate Razorpay success for a stale PENDING purchase', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedPaidCatalog(app);

      createOrderMock
        .mockResolvedValueOnce({
          id: 'order_stale_success',
          amount: PRICE_PAISE,
          currency: 'INR',
        })
        .mockResolvedValueOnce({
          id: 'order_new_pending',
          amount: PRICE_PAISE,
          currency: 'INR',
        });

      const staleCheckout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, randomUUID()))
        .send({ testSeriesId: pdf.id });

      await backdatePurchaseCreatedAt(
        staleCheckout.body.data.purchaseId,
        new Date(Date.now() - PENDING_PURCHASE_REUSE_WINDOW_MS - 1),
      );

      const freshCheckout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, randomUUID()))
        .send({ testSeriesId: pdf.id });
      expect(freshCheckout.body.data.purchaseId).not.toBe(staleCheckout.body.data.purchaseId);

      const payload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'payment.captured',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_stale_captured',
              order_id: 'order_stale_success',
              amount: PRICE_PAISE,
              currency: 'INR',
              status: 'captured',
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      });
      const webhook = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_stale_captured')
        .set('X-Razorpay-Signature', signWebhookPayload(payload, RAZORPAY_WEBHOOK_SECRET))
        .send(payload);

      expect(webhook.status).toBe(200);
      expect((await PurchaseModel.findById(staleCheckout.body.data.purchaseId))?.status).toBe(
        'PAID',
      );
      expect((await PurchaseModel.findById(freshCheckout.body.data.purchaseId))?.status).toBe(
        'PENDING',
      );
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);

      const paymentId = 'pay_verify_stale';
      fetchPaymentMock.mockResolvedValue({
        id: paymentId,
        order_id: 'order_stale_success',
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'captured',
      });
      const verified = await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send({
          purchaseId: staleCheckout.body.data.purchaseId,
          razorpayOrderId: 'order_stale_success',
          razorpayPaymentId: paymentId,
          razorpaySignature: signPaymentVerification({
            razorpayOrderId: 'order_stale_success',
            razorpayPaymentId: paymentId,
            keySecret: RAZORPAY_KEY_SECRET,
          }),
        });
      expect(verified.status).toBe(200);
      expect(verified.body.data.purchase.status).toBe('PAID');
    });
  });
});
