import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
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
import {
  ensureFreeMcqEntitlement,
  studentHasTestSeriesAccess,
} from '../src/modules/entitlements/entitlement.service';
import { PAID_ENTITLEMENT_VALIDITY_DAYS, PENDING_PURCHASE_REUSE_WINDOW_MS } from '../src/database/models/conventions';
import { backfillPurchaseReceipts } from '../src/modules/purchases/purchase-receipt';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const RAZORPAY_KEY_ID = 'rzp_test_key';
const RAZORPAY_KEY_SECRET = 'rzp_test_secret';
const RAZORPAY_WEBHOOK_SECRET = 'whsec_test_secret';
const PRICE_PAISE = 49900;
const missingId = new Types.ObjectId().toString();

const mcqScoring = { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 };

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
    email: 'evaluator@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'EVALUATOR',
    status: 'ACTIVE',
    name: { first: 'Eva', last: 'Luator' },
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

function purchaseHeaders(token: string, key = randomUUID()) {
  return { ...bearer(token), 'Idempotency-Key': key };
}

function postRazorpayWebhook(
  app: App,
  payload: Record<string, unknown> | string,
  options?: { signature?: string; omitSignature?: boolean; eventId?: string },
) {
  const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const req = request(app)
    .post('/webhooks/razorpay')
    .set('Content-Type', 'application/json');

  if (options?.eventId) {
    req.set('X-Razorpay-Event-Id', options.eventId);
  }

  if (!options?.omitSignature) {
    req.set(
      'X-Razorpay-Signature',
      options?.signature ?? signWebhookPayload(rawBody, RAZORPAY_WEBHOOK_SECRET),
    );
  }

  return req.send(rawBody);
}

function paymentCapturedPayload(input: {
  paymentId: string;
  orderId: string;
  amount?: number;
  currency?: string;
}) {
  return {
    entity: 'event',
    account_id: 'acc_test',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: input.paymentId,
          order_id: input.orderId,
          amount: input.amount ?? PRICE_PAISE,
          currency: input.currency ?? 'INR',
          status: 'captured',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
}

async function createCategory(app: App, adminToken: string) {
  const response = await request(app)
    .post('/admin/categories')
    .set(bearer(adminToken))
    .send({ name: 'Mathematics' });
  expect(response.status).toBe(201);
  return response.body.data as { id: string };
}

async function createModule(app: App, adminToken: string, categoryId: string) {
  const response = await request(app)
    .post('/admin/modules')
    .set(bearer(adminToken))
    .send({ categoryId, name: 'Algebra' });
  expect(response.status).toBe(201);
  return response.body.data as { id: string };
}

async function createTestSeries(app: App, adminToken: string, body: Record<string, unknown>) {
  const response = await request(app).post('/admin/test-series').set(bearer(adminToken)).send(body);
  expect(response.status).toBe(201);
  return response.body.data as {
    id: string;
    type: string;
    access: { isFree: boolean; price: number; currency: string };
  };
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

describe('Phase 7 purchases, entitlements, and Razorpay', () => {
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

  async function seedCatalog(app: App) {
    const adminToken = await login(app, 'admin@example.com');
    const category = await createCategory(app, adminToken);
    const module = await createModule(app, adminToken, category.id);
    const pdf = await createTestSeries(app, adminToken, {
      moduleId: module.id,
      title: 'PDF Series',
      type: 'PDF',
      duration: 3600,
      access: { isFree: false, price: PRICE_PAISE, currency: 'INR' },
    });
    const editor = await createTestSeries(app, adminToken, {
      moduleId: module.id,
      title: 'Editor Series',
      type: 'EDITOR',
      duration: 3600,
      access: { isFree: false, price: 99900, currency: 'INR' },
    });
    const mcq = await createTestSeries(app, adminToken, {
      moduleId: module.id,
      title: 'MCQ Series',
      type: 'MCQ',
      duration: 3600,
      scoring: mcqScoring,
    });
    return { adminToken, categoryId: category.id, pdf, editor, mcq };
  }

  describe('purchase creation', () => {
    it('allows authenticated student to create paid purchase with server amount', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_pdf_1',
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'created',
      });

      const response = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        purchaseId: expect.any(String),
        razorpayOrderId: 'order_pdf_1',
        razorpayKeyId: RAZORPAY_KEY_ID,
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      expect(JSON.stringify(response.body)).not.toContain(RAZORPAY_KEY_SECRET);
      expect(createOrderMock).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: PRICE_PAISE,
          currency: 'INR',
        }),
      );

      const ignoredClientAmount = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id, amount: 1, currency: 'USD', studentId: missingId });
      expect(ignoredClientAmount.status).toBe(400);
      expect(ignoredClientAmount.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const purchase = await PurchaseModel.findById(response.body.data.purchaseId);
      expect(purchase?.status).toBe('PENDING');
      expect(purchase?.amount).toBe(PRICE_PAISE);
    });

    it('rejects unauthenticated, evaluator, and admin purchase creation', async () => {
      const app = createApp();
      const { pdf } = await seedCatalog(app);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const adminToken = await login(app, 'admin@example.com');

      const unauthenticated = await request(app).post('/purchases').send({ testSeriesId: pdf.id });
      const evaluator = await request(app)
        .post('/purchases')
        .set(bearer(evaluatorToken))
        .send({ testSeriesId: pdf.id });
      const admin = await request(app)
        .post('/purchases')
        .set(bearer(adminToken))
        .send({ testSeriesId: pdf.id });

      expect(unauthenticated.status).toBe(401);
      expect(evaluator.status).toBe(403);
      expect(admin.status).toBe(403);
    });

    it('rejects nonexistent, soft-deleted, and free MCQ purchases', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { adminToken, pdf, mcq } = await seedCatalog(app);

      const missing = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: missingId });
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe(ErrorCodes.TEST_SERIES_NOT_FOUND);

      await request(app).delete(`/admin/test-series/${pdf.id}`).set(bearer(adminToken));
      const deleted = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });
      expect(deleted.status).toBe(404);

      const free = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: mcq.id });
      expect(free.status).toBe(400);
      expect(free.body.error.code).toBe(ErrorCodes.TEST_SERIES_NOT_PURCHASABLE);
      expect(createOrderMock).not.toHaveBeenCalled();
      expect(await PurchaseModel.countDocuments({})).toBe(0);
    });

    it('creates Razorpay orders for PDF and EDITOR', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf, editor } = await seedCatalog(app);

      createOrderMock
        .mockResolvedValueOnce({ id: 'order_pdf', amount: PRICE_PAISE, currency: 'INR' })
        .mockResolvedValueOnce({ id: 'order_editor', amount: 99900, currency: 'INR' });

      const pdfPurchase = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });
      const editorPurchase = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: editor.id });

      expect(pdfPurchase.status).toBe(201);
      expect(pdfPurchase.body.data.razorpayOrderId).toBe('order_pdf');
      expect(editorPurchase.status).toBe(201);
      expect(editorPurchase.body.data.amount).toBe(99900);
    });

    it('rejects MongoDB operators and unknown fields', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      const operators = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: { $gt: '' } });
      const unknown = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id, status: 'PAID' });

      expect(operators.status).toBe(400);
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('blocks purchase while active entitlement exists and allows repurchase after expiry', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const student = await userRepository.findByEmail('student@example.com');
      const { pdf } = await seedCatalog(app);

      const grantedAt = new Date();
      await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        purchaseId: new Types.ObjectId(),
        status: 'ACTIVE',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      createOrderMock.mockResolvedValue({
        id: 'order_blocked',
        amount: PRICE_PAISE,
        currency: 'INR',
      });

      const blocked = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe(ErrorCodes.PURCHASE_ALREADY_OWNED);

      await EntitlementModel.updateOne(
        { studentId: student!._id, testSeriesId: pdf.id },
        {
          $set: {
            status: 'EXPIRED',
            expiresAt: addDays(grantedAt, -1),
          },
        },
      );

      createOrderMock.mockResolvedValue({
        id: 'order_repurchase',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const repurchase = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });
      expect(repurchase.status).toBe(201);
      expect(repurchase.body.data.razorpayOrderId).toBe('order_repurchase');
    });

    it('allows concurrent pending purchases for different students on the same test series', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const student2Token = await login(app, 'student2@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValueOnce({
        id: 'order_student_one',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      createOrderMock.mockResolvedValueOnce({
        id: 'order_student_two',
        amount: PRICE_PAISE,
        currency: 'INR',
      });

      const first = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });
      const second = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(student2Token))
        .send({ testSeriesId: pdf.id });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.purchaseId).not.toBe(first.body.data.purchaseId);
      expect(await PurchaseModel.countDocuments({ status: 'PENDING' })).toBe(2);
    });

    it('reuses an existing PENDING purchase for the same test series', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_reuse',
        amount: PRICE_PAISE,
        currency: 'INR',
      });

      const first = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });
      const second = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.purchaseId).toBe(first.body.data.purchaseId);
      expect(createOrderMock).toHaveBeenCalledTimes(1);
      expect(await PurchaseModel.countDocuments({})).toBe(1);
    });

    it('marks purchase FAILED when Razorpay order creation fails', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockRejectedValue(new Error('provider down'));

      const response = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      expect(response.status).toBe(502);
      const purchase = await PurchaseModel.findOne({ testSeriesId: pdf.id });
      expect(purchase?.status).toBe('FAILED');
      expect(purchase?.razorpayOrderId).toBeNull();
    });
  });

  describe('pending purchase checkout resume', () => {
    async function createPendingPurchaseCheckout(
      app: App,
      studentToken: string,
      testSeriesId: string,
      orderId = 'order_resume',
    ) {
      createOrderMock.mockResolvedValue({
        id: orderId,
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const response = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId });
      expect(response.status).toBe(201);
      return response.body.data as {
        purchaseId: string;
        razorpayOrderId: string;
        razorpayKeyId: string;
        amount: number;
        currency: string;
      };
    }

    async function backdatePurchaseCreatedAt(purchaseId: string, createdAt: Date): Promise<void> {
      const result = await PurchaseModel.collection.updateOne(
        { _id: new Types.ObjectId(purchaseId) },
        { $set: { createdAt } },
      );
      expect(result.modifiedCount).toBe(1);
    }

    it('returns checkout material for reusable pending purchase', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchaseCheckout(app, studentToken, pdf.id);

      const resume = await request(app)
        .get(`/me/purchases/${checkout.purchaseId}/checkout`)
        .set(bearer(studentToken));

      expect(resume.status).toBe(200);
      expect(resume.body.data).toEqual({
        purchaseId: checkout.purchaseId,
        razorpayOrderId: checkout.razorpayOrderId,
        razorpayKeyId: RAZORPAY_KEY_ID,
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      expect(createOrderMock).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when another student requests checkout', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const otherToken = await login(app, 'student2@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchaseCheckout(app, studentToken, pdf.id);

      const response = await request(app)
        .get(`/me/purchases/${checkout.purchaseId}/checkout`)
        .set(bearer(otherToken));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(ErrorCodes.PURCHASE_NOT_FOUND);
    });

    it('returns 409 when purchase is not pending', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchaseCheckout(app, studentToken, pdf.id);

      await PurchaseModel.updateOne(
        { _id: checkout.purchaseId },
        { $set: { status: 'PAID' } },
      );

      const paid = await request(app)
        .get(`/me/purchases/${checkout.purchaseId}/checkout`)
        .set(bearer(studentToken));
      expect(paid.status).toBe(409);

      await PurchaseModel.updateOne(
        { _id: checkout.purchaseId },
        { $set: { status: 'FAILED' } },
      );

      const failed = await request(app)
        .get(`/me/purchases/${checkout.purchaseId}/checkout`)
        .set(bearer(studentToken));
      expect(failed.status).toBe(409);
    });

    it('returns 409 when pending purchase reuse window expired', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchaseCheckout(app, studentToken, pdf.id);

      await backdatePurchaseCreatedAt(
        checkout.purchaseId,
        new Date(Date.now() - PENDING_PURCHASE_REUSE_WINDOW_MS - 1),
      );

      const response = await request(app)
        .get(`/me/purchases/${checkout.purchaseId}/checkout`)
        .set(bearer(studentToken));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCodes.TEST_SERIES_NOT_PURCHASABLE);
    });

    it('returns 409 when student already has active entitlement', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const student = await userRepository.findByEmail('student@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchaseCheckout(app, studentToken, pdf.id);

      const grantedAt = new Date();
      await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        purchaseId: new Types.ObjectId(),
        status: 'ACTIVE',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      const response = await request(app)
        .get(`/me/purchases/${checkout.purchaseId}/checkout`)
        .set(bearer(studentToken));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ErrorCodes.PURCHASE_ALREADY_OWNED);
    });
  });

  describe('payment verification and entitlement', () => {
    async function createPendingPurchase(app: App, studentToken: string, testSeriesId: string) {
      createOrderMock.mockResolvedValue({
        id: 'order_verify_1',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const response = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId });
      expect(response.status).toBe(201);
      return response.body.data as {
        purchaseId: string;
        razorpayOrderId: string;
        amount: number;
        currency: string;
      };
    }

    it('verifies payment, marks PAID, and creates a 60-day ACTIVE entitlement', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const student = await userRepository.findByEmail('student@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchase(app, studentToken, pdf.id);

      const paymentId = 'pay_verify_1';
      const signature = signPaymentVerification({
        razorpayOrderId: checkout.razorpayOrderId,
        razorpayPaymentId: paymentId,
        keySecret: RAZORPAY_KEY_SECRET,
      });

      fetchPaymentMock.mockResolvedValue({
        id: paymentId,
        order_id: checkout.razorpayOrderId,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'captured',
      });

      const before = new Date();
      const verified = await request(app).post('/payments/verify').set(bearer(studentToken)).send({
        purchaseId: checkout.purchaseId,
        razorpayOrderId: checkout.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      });
      const after = new Date();

      expect(verified.status).toBe(200);
      expect(verified.body.data.purchase.status).toBe('PAID');
      expect(verified.body.data.entitlement.status).toBe('ACTIVE');
      expect(verified.body.data.entitlement.purchaseId).toBe(checkout.purchaseId);
      expect(verified.body.data.entitlement.studentId).toBe(student!._id.toString());
      expect(verified.body.data.entitlement.testSeriesId).toBe(pdf.id);

      const grantedAt = new Date(verified.body.data.entitlement.grantedAt);
      const expiresAt = new Date(verified.body.data.entitlement.expiresAt);
      expect(grantedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(grantedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
      expect(expiresAt.getTime()).toBe(
        addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS).getTime(),
      );

      const access = await studentHasTestSeriesAccess(student!._id.toString(), pdf.id);
      expect(access.hasAccess).toBe(true);

      const receipt = verified.body.data.purchase.receipt as { number: string; issuedAt: string };
      expect(receipt.number).toMatch(/^XP-\d{4}-\d{6}$/);
      expect(receipt.issuedAt).toBe(verified.body.data.entitlement.grantedAt);

      const again = await request(app).post('/payments/verify').set(bearer(studentToken)).send({
        purchaseId: checkout.purchaseId,
        razorpayOrderId: checkout.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      });
      expect(again.status).toBe(200);
      expect(again.body.data.purchase.receipt.number).toBe(receipt.number);

      const downloaded = await request(app)
        .get(`/me/purchases/${checkout.purchaseId}/receipt`)
        .set(bearer(studentToken));
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers['content-type']).toContain('application/pdf');
      expect(downloaded.headers['content-disposition']).toContain(`${receipt.number}.pdf`);
      expect(downloaded.body.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('backfills receipts for paid purchases in entitlement grantedAt order', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const student = await userRepository.findByEmail('student@example.com');
      const { pdf } = await seedCatalog(app);
      const olderGrantedAt = new Date('2025-06-01T04:30:00.000Z');
      const newerGrantedAt = new Date('2026-02-01T04:30:00.000Z');

      const older = await PurchaseModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'PAID',
        razorpayOrderId: 'order_receipt_old',
        razorpayPaymentId: 'pay_receipt_old',
      });
      const newer = await PurchaseModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'PAID',
        razorpayOrderId: 'order_receipt_new',
        razorpayPaymentId: 'pay_receipt_new',
      });
      const missingEntitlement = await PurchaseModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'PAID',
        razorpayOrderId: 'order_receipt_none',
        razorpayPaymentId: 'pay_receipt_none',
      });

      await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        purchaseId: newer._id,
        status: 'EXPIRED',
        grantedAt: newerGrantedAt,
        expiresAt: addDays(newerGrantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });
      await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        purchaseId: older._id,
        status: 'EXPIRED',
        grantedAt: olderGrantedAt,
        expiresAt: addDays(olderGrantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      const result = await backfillPurchaseReceipts();
      expect(result.issued).toBe(2);
      expect(result.skippedNoEntitlement).toEqual([missingEntitlement._id.toString()]);
      expect(result.skippedNoSeriesTitle).toEqual([]);

      const olderPaid = await PurchaseModel.findById(older._id);
      const newerPaid = await PurchaseModel.findById(newer._id);
      expect(olderPaid?.receipt?.number).toBe('XP-2025-000001');
      expect(olderPaid?.receipt?.issuedAt?.toISOString()).toBe(olderGrantedAt.toISOString());
      expect(olderPaid?.receipt?.studentName).toBe('Stu Dent');
      expect(olderPaid?.receipt?.testSeriesTitle).toBe('PDF Series');
      expect(newerPaid?.receipt?.number).toBe('XP-2026-000001');

      const pending = await request(app)
        .get(`/me/purchases/${missingEntitlement._id.toString()}/receipt`)
        .set(bearer(await login(app, 'student@example.com')));
      expect(pending.status).toBe(409);
      expect(pending.body.error.code).toBe(ErrorCodes.RECEIPT_NOT_ISSUED);

      const other = await request(app)
        .get(`/me/purchases/${older._id.toString()}/receipt`)
        .set(bearer(await login(app, 'student2@example.com')));
      expect(other.status).toBe(404);

      const adminDownload = await request(app)
        .get(`/admin/purchases/${older._id.toString()}/receipt`)
        .set(bearer(adminToken));
      expect(adminDownload.status).toBe(200);
      expect(adminDownload.headers['content-disposition']).toContain('XP-2025-000001.pdf');
    });

    it('rejects invalid signatures, unknown orders, and wrong linkage', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchase(app, studentToken, pdf.id);

      const invalid = await request(app).post('/payments/verify').set(bearer(studentToken)).send({
        purchaseId: checkout.purchaseId,
        razorpayOrderId: checkout.razorpayOrderId,
        razorpayPaymentId: 'pay_bad',
        razorpaySignature: 'deadbeef',
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe(ErrorCodes.INVALID_PAYMENT_SIGNATURE);

      const mismatch = await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send({
          purchaseId: checkout.purchaseId,
          razorpayOrderId: 'order_other',
          razorpayPaymentId: 'pay_bad',
          razorpaySignature: signPaymentVerification({
            razorpayOrderId: 'order_other',
            razorpayPaymentId: 'pay_bad',
            keySecret: RAZORPAY_KEY_SECRET,
          }),
        });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.error.code).toBe(ErrorCodes.PAYMENT_ORDER_MISMATCH);

      expect(await EntitlementModel.countDocuments({})).toBe(0);
      expect((await PurchaseModel.findById(checkout.purchaseId))?.status).toBe('PENDING');
    });

    it('is idempotent on duplicate verification', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchase(app, studentToken, pdf.id);
      const paymentId = 'pay_idem_1';
      const signature = signPaymentVerification({
        razorpayOrderId: checkout.razorpayOrderId,
        razorpayPaymentId: paymentId,
        keySecret: RAZORPAY_KEY_SECRET,
      });
      fetchPaymentMock.mockResolvedValue({
        id: paymentId,
        order_id: checkout.razorpayOrderId,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'captured',
      });

      const body = {
        purchaseId: checkout.purchaseId,
        razorpayOrderId: checkout.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      };

      const first = await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send(body);
      const second = await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send(body);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.entitlement.id).toBe(first.body.data.entitlement.id);
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
    });

    it('prevents student A from verifying or reading student B purchase/entitlement', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const otherToken = await login(app, 'student2@example.com');
      const { pdf } = await seedCatalog(app);
      const checkout = await createPendingPurchase(app, studentToken, pdf.id);

      const paymentId = 'pay_cross';
      fetchPaymentMock.mockResolvedValue({
        id: paymentId,
        order_id: checkout.razorpayOrderId,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'captured',
      });

      const verifyOther = await request(app)
        .post('/payments/verify')
        .set(bearer(otherToken))
        .send({
          purchaseId: checkout.purchaseId,
          razorpayOrderId: checkout.razorpayOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signPaymentVerification({
            razorpayOrderId: checkout.razorpayOrderId,
            razorpayPaymentId: paymentId,
            keySecret: RAZORPAY_KEY_SECRET,
          }),
        });
      expect(verifyOther.status).toBe(404);

      const owned = await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send({
          purchaseId: checkout.purchaseId,
          razorpayOrderId: checkout.razorpayOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signPaymentVerification({
            razorpayOrderId: checkout.razorpayOrderId,
            razorpayPaymentId: paymentId,
            keySecret: RAZORPAY_KEY_SECRET,
          }),
        });
      expect(owned.status).toBe(200);

      const otherPurchase = await request(app)
        .get(`/me/purchases/${checkout.purchaseId}`)
        .set(bearer(otherToken));
      const otherEntitlement = await request(app)
        .get(`/me/entitlements/${owned.body.data.entitlement.id}`)
        .set(bearer(otherToken));

      expect(otherPurchase.status).toBe(404);
      expect(otherEntitlement.status).toBe(404);
    });

    it('includes attempts usage on student entitlement list and detail', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);
      const student = await userRepository.findByEmail('student@example.com');
      const grantedAt = new Date();
      const entitlement = await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        purchaseId: new Types.ObjectId(),
        status: 'ACTIVE',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      const list = await request(app).get('/me/entitlements').set(bearer(studentToken));
      expect(list.status).toBe(200);
      const row = list.body.data.find((item: { id: string }) => item.id === entitlement._id.toString());
      expect(row.attempts).toEqual({ used: 0, max: 3, remaining: 3 });

      const startedAt = new Date();
      await AttemptModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        entitlementId: entitlement._id,
        status: 'SUBMITTED',
        startedAt,
        examEndsAt: addDays(startedAt, 1),
        submittedAt: startedAt,
        attemptNumber: 1,
        version: 1,
        configurationSnapshot: { duration: 3600, maxScore: 100 },
      });

      const detail = await request(app)
        .get(`/me/entitlements/${entitlement._id.toString()}`)
        .set(bearer(studentToken));
      expect(detail.status).toBe(200);
      expect(detail.body.data.attempts).toEqual({ used: 1, max: 3, remaining: 2 });
    });

    it('purchased=true lists only purchase-backed entitlements, active first', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { mcq, pdf, editor } = await seedCatalog(app);
      const student = await userRepository.findByEmail('student@example.com');
      const grantedAt = new Date();

      await ensureFreeMcqEntitlement(student!._id.toString(), mcq.id);

      const expiredPaid = await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        purchaseId: new Types.ObjectId(),
        status: 'EXPIRED',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      const activePaid = await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: editor.id,
        purchaseId: new Types.ObjectId(),
        status: 'ACTIVE',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      const filtered = await request(app)
        .get('/me/entitlements')
        .query({ purchased: 'true' })
        .set(bearer(studentToken));

      expect(filtered.status).toBe(200);
      expect(filtered.body.data.map((item: { id: string }) => item.id)).toEqual([
        activePaid._id.toString(),
        expiredPaid._id.toString(),
      ]);
      expect(filtered.body.pagination.total).toBe(2);

      const all = await request(app).get('/me/entitlements').set(bearer(studentToken));
      expect(all.body.data).toHaveLength(3);
    });

    it('rejects student entitlement mutation attempts', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');

      const post = await request(app)
        .post('/entitlements')
        .set(bearer(studentToken))
        .send({ testSeriesId: missingId });
      const patch = await request(app)
        .patch(`/entitlements/${missingId}`)
        .set(bearer(studentToken))
        .send({ status: 'REVOKED' });

      expect(post.status).toBe(404);
      expect(patch.status).toBe(404);
    });

    it('treats expired entitlements as no access for paid series and requires expiresAt', async () => {
      const app = createApp();
      const student = await userRepository.findByEmail('student@example.com');
      const { pdf } = await seedCatalog(app);
      const grantedAt = addDays(new Date(), -90);

      await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        purchaseId: new Types.ObjectId(),
        status: 'ACTIVE',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      const access = await studentHasTestSeriesAccess(student!._id.toString(), pdf.id);
      expect(access.hasAccess).toBe(false);
      expect(access.reason).toBe('ENTITLEMENT_EXPIRED');

      const normalized = await EntitlementModel.findOne({
        studentId: student!._id,
        testSeriesId: pdf.id,
      });
      expect(normalized?.status).toBe('EXPIRED');
      expect(normalized?.expiresAt).toBeInstanceOf(Date);
    });

    it('keeps historical entitlement after repurchase', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const student = await userRepository.findByEmail('student@example.com');
      const { pdf } = await seedCatalog(app);

      const oldGrantedAt = addDays(new Date(), -90);
      await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: pdf.id,
        purchaseId: new Types.ObjectId(),
        status: 'EXPIRED',
        grantedAt: oldGrantedAt,
        expiresAt: addDays(oldGrantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      createOrderMock.mockResolvedValue({ id: 'order_hist', amount: PRICE_PAISE, currency: 'INR' });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });
      const paymentId = 'pay_hist';
      fetchPaymentMock.mockResolvedValue({
        id: paymentId,
        order_id: 'order_hist',
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'captured',
      });

      await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send({
          purchaseId: checkout.body.data.purchaseId,
          razorpayOrderId: 'order_hist',
          razorpayPaymentId: paymentId,
          razorpaySignature: signPaymentVerification({
            razorpayOrderId: 'order_hist',
            razorpayPaymentId: paymentId,
            keySecret: RAZORPAY_KEY_SECRET,
          }),
        });

      expect(await EntitlementModel.countDocuments({ testSeriesId: pdf.id })).toBe(2);
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
      expect(await EntitlementModel.countDocuments({ status: 'EXPIRED' })).toBe(1);
    });
  });

  describe('free MCQ', () => {
    it('grants purchaseId=null entitlement with expiresAt=null and does not create a Purchase', async () => {
      const app = createApp();
      const student = await userRepository.findByEmail('student@example.com');
      const { mcq } = await seedCatalog(app);

      const accessBefore = await studentHasTestSeriesAccess(student!._id.toString(), mcq.id);
      expect(accessBefore.hasAccess).toBe(true);
      expect(createOrderMock).not.toHaveBeenCalled();
      expect(await PurchaseModel.countDocuments({})).toBe(0);

      const first = await ensureFreeMcqEntitlement(student!._id.toString(), mcq.id);
      const second = await ensureFreeMcqEntitlement(student!._id.toString(), mcq.id);

      expect(first.purchaseId).toBeNull();
      expect(first.expiresAt).toBeNull();
      expect(first.status).toBe('ACTIVE');
      expect(second.id).toBe(first.id);
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
      expect(await PurchaseModel.countDocuments({})).toBe(0);

      const stored = await EntitlementModel.findById(first.id);
      expect(stored?.purchaseId).toBeNull();
      expect(stored?.expiresAt).toBeNull();
    });

    it('does not gate free MCQ access on entitlement expiry', async () => {
      const app = createApp();
      const student = await userRepository.findByEmail('student@example.com');
      const { mcq } = await seedCatalog(app);
      const grantedAt = addDays(new Date(), -90);

      // Historical free MCQ rows may have an artificial expiresAt; access must ignore it.
      await EntitlementModel.create({
        studentId: student!._id,
        testSeriesId: mcq.id,
        purchaseId: null,
        status: 'ACTIVE',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      const access = await studentHasTestSeriesAccess(student!._id.toString(), mcq.id);
      expect(access.hasAccess).toBe(true);
      expect(access.entitlementId).toBeDefined();

      const stillActive = await EntitlementModel.findOne({
        studentId: student!._id,
        testSeriesId: mcq.id,
      });
      expect(stillActive?.status).toBe('ACTIVE');
    });

    it('preserves active-entitlement uniqueness for free MCQ', async () => {
      const app = createApp();
      const student = await userRepository.findByEmail('student@example.com');
      const { mcq } = await seedCatalog(app);

      await ensureFreeMcqEntitlement(student!._id.toString(), mcq.id);

      await expect(
        EntitlementModel.create({
          studentId: student!._id,
          testSeriesId: mcq.id,
          purchaseId: null,
          status: 'ACTIVE',
          grantedAt: new Date(),
          expiresAt: null,
        }),
      ).rejects.toThrow();

      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
    });
  });

  describe('webhooks', () => {
    it('processes a valid payment.captured webhook and is idempotent', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_wh_1',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      const payload = paymentCapturedPayload({
        paymentId: 'pay_wh_1',
        orderId: 'order_wh_1',
      });
      const rawBody = JSON.stringify(payload);
      const signature = signWebhookPayload(rawBody, RAZORPAY_WEBHOOK_SECRET);

      const first = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_wh_1')
        .set('X-Razorpay-Signature', signature)
        .send(rawBody);
      const second = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_wh_1')
        .set('X-Razorpay-Signature', signature)
        .send(rawBody);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.duplicate).toBe(true);
      expect((await PurchaseModel.findById(checkout.body.data.purchaseId))?.status).toBe('PAID');
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
      expect(await WebhookEventModel.countDocuments({})).toBe(1);
    });

    it('rejects invalid webhook signatures and does not create entitlement for unknown purchase', async () => {
      const app = createApp();
      await seedCatalog(app);

      const payload = paymentCapturedPayload({
        paymentId: 'pay_unknown',
        orderId: 'order_unknown',
      });
      const rawBody = JSON.stringify(payload);

      const invalid = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_bad')
        .set('X-Razorpay-Signature', 'invalid')
        .send(rawBody);
      expect(invalid.status).toBe(401);
      expect(invalid.body.error.code).toBe(ErrorCodes.INVALID_WEBHOOK_SIGNATURE);

      const signature = signWebhookPayload(rawBody, RAZORPAY_WEBHOOK_SECRET);
      const unknown = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_bad')
        .set('X-Razorpay-Signature', signature)
        .send(rawBody);

      expect(unknown.status).toBe(200);
      expect(await EntitlementModel.countDocuments({})).toBe(0);
    });

    it('marks FAILED on payment.failed without creating entitlement', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_fail',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      const failPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'payment.failed',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_fail',
              order_id: 'order_fail',
              amount: PRICE_PAISE,
              currency: 'INR',
              status: 'failed',
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      });
      const failed = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_fail')
        .set('X-Razorpay-Signature', signWebhookPayload(failPayload, RAZORPAY_WEBHOOK_SECRET))
        .send(failPayload);

      expect(failed.status).toBe(200);
      expect((await PurchaseModel.findById(checkout.body.data.purchaseId))?.status).toBe('FAILED');
      expect(await EntitlementModel.countDocuments({})).toBe(0);
    });

    it('acknowledges refund.processed without mutating purchase, revoking entitlement, or creating a refund record', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_refund',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      await PurchaseModel.findByIdAndUpdate(checkout.body.data.purchaseId, {
        $set: { status: 'PAID', razorpayPaymentId: 'pay_refund' },
      });
      await EntitlementModel.create({
        studentId: (await userRepository.findByEmail('student@example.com'))!._id,
        testSeriesId: pdf.id,
        purchaseId: checkout.body.data.purchaseId,
        status: 'ACTIVE',
        grantedAt: new Date(),
        expiresAt: addDays(new Date(), 60),
      });

      const refundPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'refund.processed',
        contains: ['refund'],
        payload: {
          refund: {
            entity: {
              id: 'rfnd_1',
              payment_id: 'pay_refund',
              amount: PRICE_PAISE,
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      });
      const signature = signWebhookPayload(refundPayload, RAZORPAY_WEBHOOK_SECRET);

      const first = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_refund')
        .set('X-Razorpay-Signature', signature)
        .send(refundPayload);
      const second = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_refund')
        .set('X-Razorpay-Signature', signature)
        .send(refundPayload);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.duplicate).toBe(true);

      const purchase = await PurchaseModel.findById(checkout.body.data.purchaseId);
      expect(purchase?.status).toBe('PAID');
      expect(purchase?.status).not.toBe('REFUNDED');
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
      expect(await EntitlementModel.countDocuments({ status: 'REVOKED' })).toBe(0);
      expect(await WebhookEventModel.countDocuments({ eventId: 'evt_refund' })).toBe(1);
      expect(await WebhookEventModel.countDocuments({ eventType: 'refund.processed' })).toBe(1);
    });

    it('marks purchase PAID when webhook arrives before client verify', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_wh_first',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      const paymentId = 'pay_wh_first';
      const webhook = await postRazorpayWebhook(
        app,
        paymentCapturedPayload({
          paymentId,
          orderId: 'order_wh_first',
        }),
        { eventId: 'evt_wh_first' },
      );
      expect(webhook.status).toBe(200);
      expect(webhook.body.data.duplicate).toBe(false);

      fetchPaymentMock.mockResolvedValue({
        id: paymentId,
        order_id: 'order_wh_first',
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'captured',
      });
      const verified = await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send({
          purchaseId: checkout.body.data.purchaseId,
          razorpayOrderId: 'order_wh_first',
          razorpayPaymentId: paymentId,
          razorpaySignature: signPaymentVerification({
            razorpayOrderId: 'order_wh_first',
            razorpayPaymentId: paymentId,
            keySecret: RAZORPAY_KEY_SECRET,
          }),
        });

      expect(verified.status).toBe(200);
      expect(verified.body.data.purchase.status).toBe('PAID');
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
    });

    it('marks purchase PAID when client verify arrives before webhook', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_verify_first',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      const paymentId = 'pay_verify_first';
      fetchPaymentMock.mockResolvedValue({
        id: paymentId,
        order_id: 'order_verify_first',
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'captured',
      });
      const verified = await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send({
          purchaseId: checkout.body.data.purchaseId,
          razorpayOrderId: 'order_verify_first',
          razorpayPaymentId: paymentId,
          razorpaySignature: signPaymentVerification({
            razorpayOrderId: 'order_verify_first',
            razorpayPaymentId: paymentId,
            keySecret: RAZORPAY_KEY_SECRET,
          }),
        });
      expect(verified.status).toBe(200);

      const webhook = await postRazorpayWebhook(
        app,
        paymentCapturedPayload({
          paymentId,
          orderId: 'order_verify_first',
        }),
        { eventId: 'evt_verify_first' },
      );

      expect(webhook.status).toBe(200);
      expect(webhook.body.data.duplicate).toBe(false);
      expect((await PurchaseModel.findById(checkout.body.data.purchaseId))?.status).toBe('PAID');
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
    });

    it('rejects webhook amount and currency mismatches without granting entitlement', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_mismatch',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      const amountMismatch = await postRazorpayWebhook(
        app,
        paymentCapturedPayload({
          paymentId: 'pay_amount_mismatch',
          orderId: 'order_mismatch',
          amount: PRICE_PAISE - 100,
        }),
        { eventId: 'evt_amount_mismatch' },
      );
      expect(amountMismatch.status).toBe(400);
      expect(amountMismatch.body.error.code).toBe(ErrorCodes.PAYMENT_AMOUNT_MISMATCH);

      const currencyMismatch = await postRazorpayWebhook(
        app,
        paymentCapturedPayload({
          paymentId: 'pay_currency_mismatch',
          orderId: 'order_mismatch',
          currency: 'USD',
        }),
        { eventId: 'evt_currency_mismatch' },
      );
      expect(currencyMismatch.status).toBe(400);
      expect(currencyMismatch.body.error.code).toBe(ErrorCodes.PAYMENT_AMOUNT_MISMATCH);

      expect((await PurchaseModel.findById(checkout.body.data.purchaseId))?.status).toBe('PENDING');
      expect(await EntitlementModel.countDocuments({})).toBe(0);
    });

    it('rejects missing signature and malformed webhook payloads', async () => {
      const app = createApp();
      await seedCatalog(app);

      const missingSignature = await postRazorpayWebhook(
        app,
        paymentCapturedPayload({
          paymentId: 'pay_missing_sig',
          orderId: 'order_missing_sig',
        }),
        { eventId: 'evt_missing_sig', omitSignature: true },
      );
      expect(missingSignature.status).toBe(401);
      expect(missingSignature.body.error.code).toBe(ErrorCodes.INVALID_WEBHOOK_SIGNATURE);

      const malformed = await postRazorpayWebhook(app, '{not-json');
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(await WebhookEventModel.countDocuments({})).toBe(0);

      const missingIdentifiers = await postRazorpayWebhook(app, { event: 'payment.captured' });
      expect(missingIdentifiers.status).toBe(400);
      expect(missingIdentifiers.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(await WebhookEventModel.countDocuments({})).toBe(0);
    });

    it('acknowledges unknown webhook event types without mutating purchases', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_unknown_evt',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      const unknownEvent = await postRazorpayWebhook(
        app,
        {
          entity: 'event',
          account_id: 'acc_test',
          event: 'order.paid',
          contains: [],
          payload: {},
          created_at: Math.floor(Date.now() / 1000),
        },
        { eventId: 'evt_unknown_type' },
      );

      expect(unknownEvent.status).toBe(200);
      expect(unknownEvent.body.data.processed).toBe(true);
      expect((await PurchaseModel.findById(checkout.body.data.purchaseId))?.status).toBe('PENDING');
      expect(await EntitlementModel.countDocuments({})).toBe(0);
      expect(await WebhookEventModel.countDocuments({ eventId: 'evt_unknown_type' })).toBe(1);
    });

    it('does not downgrade a PAID purchase on payment.failed', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_paid_fail',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const checkout = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      await PurchaseModel.findByIdAndUpdate(checkout.body.data.purchaseId, {
        $set: { status: 'PAID', razorpayPaymentId: 'pay_paid_fail' },
      });

      const failPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'payment.failed',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_paid_fail',
              order_id: 'order_paid_fail',
              amount: PRICE_PAISE,
              currency: 'INR',
              status: 'failed',
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      });
      const failed = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_paid_fail')
        .set('X-Razorpay-Signature', signWebhookPayload(failPayload, RAZORPAY_WEBHOOK_SECRET))
        .send(failPayload);

      expect(failed.status).toBe(200);
      expect((await PurchaseModel.findById(checkout.body.data.purchaseId))?.status).toBe('PAID');
    });

    it('handles concurrent duplicate webhook delivery with a single entitlement', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({
        id: 'order_concurrent',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      const payload = paymentCapturedPayload({
        paymentId: 'pay_concurrent',
        orderId: 'order_concurrent',
      });
      const rawBody = JSON.stringify(payload);
      const signature = signWebhookPayload(rawBody, RAZORPAY_WEBHOOK_SECRET);
      const send = () =>
        request(app)
          .post('/webhooks/razorpay')
          .set('Content-Type', 'application/json')
          .set('X-Razorpay-Event-Id', 'evt_concurrent')
          .set('X-Razorpay-Signature', signature)
          .send(rawBody);

      const [first, second] = await Promise.all([send(), send()]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
      expect(await WebhookEventModel.countDocuments({ eventId: 'evt_concurrent' })).toBe(1);
    });
  });

  describe('lists and admin reads', () => {
    it('lists only the authenticated student purchases and entitlements', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const otherToken = await login(app, 'student2@example.com');
      const adminToken = await login(app, 'admin@example.com');
      const { pdf, categoryId } = await seedCatalog(app);

      createOrderMock.mockResolvedValue({ id: 'order_list', amount: PRICE_PAISE, currency: 'INR' });
      await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken))
        .send({ testSeriesId: pdf.id });

      const studentList = await request(app).get('/me/purchases').set(bearer(studentToken));
      const otherList = await request(app).get('/me/purchases').set(bearer(otherToken));
      const adminList = await request(app).get('/admin/purchases').set(bearer(adminToken));

      expect(studentList.status).toBe(200);
      expect(studentList.body.data).toHaveLength(1);
      expect(studentList.body.data[0].testSeries).toEqual({
        id: pdf.id,
        title: 'PDF Series',
        type: 'PDF',
        moduleName: 'Algebra',
        categoryId,
        categoryName: 'Mathematics',
      });

      const studentGet = await request(app)
        .get(`/me/purchases/${studentList.body.data[0].id}`)
        .set(bearer(studentToken));
      expect(studentGet.status).toBe(200);
      expect(studentGet.body.data.testSeries).toEqual({
        id: pdf.id,
        title: 'PDF Series',
        type: 'PDF',
        moduleName: 'Algebra',
        categoryId,
        categoryName: 'Mathematics',
      });

      expect(otherList.status).toBe(200);
      expect(otherList.body.data).toHaveLength(0);
      expect(adminList.status).toBe(200);
      expect(adminList.body.data).toHaveLength(1);
      expect(adminList.body.data[0].testSeries).toEqual({
        id: pdf.id,
        title: 'PDF Series',
        type: 'PDF',
        moduleName: 'Algebra',
        categoryId,
        categoryName: 'Mathematics',
      });
    });
  });

  describe('admin commerce filters and detail reads', () => {
    async function seedAdminCommerceRows(testSeriesId: string) {
      const student = await userRepository.findByEmail('student@example.com');
      const other = await userRepository.findByEmail('student2@example.com');
      const studentId = student!._id;
      const otherId = other!._id;

      const paid = await PurchaseModel.create({
        studentId,
        testSeriesId,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'PAID',
        razorpayOrderId: 'order_paid',
        razorpayPaymentId: 'pay_paid',
      });
      const failed = await PurchaseModel.create({
        studentId: otherId,
        testSeriesId,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'FAILED',
        razorpayOrderId: 'order_failed',
      });

      const grantedAt = new Date();
      const activeEntitlement = await EntitlementModel.create({
        studentId,
        testSeriesId,
        purchaseId: paid._id,
        status: 'ACTIVE',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });
      const revokedEntitlement = await EntitlementModel.create({
        studentId: otherId,
        testSeriesId,
        purchaseId: failed._id,
        status: 'REVOKED',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });

      return {
        studentId: studentId.toString(),
        otherId: otherId.toString(),
        paid,
        failed,
        activeEntitlement,
        revokedEntitlement,
      };
    }

    it('filters admin purchases by status and student', async () => {
      const app = createApp();
      const { pdf, adminToken } = await seedCatalog(app);
      const seeded = await seedAdminCommerceRows(pdf.id);

      const byStatus = await request(app)
        .get('/admin/purchases?status=PAID')
        .set(bearer(adminToken));
      expect(byStatus.status).toBe(200);
      expect(byStatus.body.data).toHaveLength(1);
      expect(byStatus.body.data[0].id).toBe(seeded.paid._id.toString());
      expect(byStatus.body.pagination.total).toBe(1);

      const byStudent = await request(app)
        .get(`/admin/purchases?studentId=${seeded.otherId}`)
        .set(bearer(adminToken));
      expect(byStudent.status).toBe(200);
      expect(byStudent.body.data).toHaveLength(1);
      expect(byStudent.body.data[0].id).toBe(seeded.failed._id.toString());
    });

    it('filters admin purchases by created date range', async () => {
      const app = createApp();
      const { pdf, adminToken } = await seedCatalog(app);
      await seedAdminCommerceRows(pdf.id);

      const future = addDays(new Date(), 1).toISOString();
      const empty = await request(app)
        .get(`/admin/purchases?createdFrom=${future}`)
        .set(bearer(adminToken));
      expect(empty.status).toBe(200);
      expect(empty.body.data).toHaveLength(0);

      const past = addDays(new Date(), -1).toISOString();
      const all = await request(app)
        .get(`/admin/purchases?createdFrom=${past}`)
        .set(bearer(adminToken));
      expect(all.body.data).toHaveLength(2);
    });

    it('rejects invalid admin commerce filter values', async () => {
      const app = createApp();
      const { adminToken } = await seedCatalog(app);

      const badStatus = await request(app)
        .get('/admin/purchases?status=REFUNDED')
        .set(bearer(adminToken));
      expect(badStatus.status).toBe(400);
      expect(badStatus.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const badDate = await request(app)
        .get('/admin/entitlements?grantedFrom=not-a-date')
        .set(bearer(adminToken));
      expect(badDate.status).toBe(400);

      const badStudent = await request(app)
        .get('/admin/purchases?studentId=abc')
        .set(bearer(adminToken));
      expect(badStudent.status).toBe(400);
    });

    it('filters admin entitlements by status', async () => {
      const app = createApp();
      const { pdf, adminToken } = await seedCatalog(app);
      const seeded = await seedAdminCommerceRows(pdf.id);

      const response = await request(app)
        .get('/admin/entitlements?status=REVOKED')
        .set(bearer(adminToken));
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(seeded.revokedEntitlement._id.toString());
    });

    it('reports attempts used and remaining per entitlement', async () => {
      const app = createApp();
      const { pdf, adminToken } = await seedCatalog(app);
      const seeded = await seedAdminCommerceRows(pdf.id);

      const list = await request(app).get('/admin/entitlements').set(bearer(adminToken));
      expect(list.status).toBe(200);
      const withoutAttempts = list.body.data.find(
        (row: { id: string }) => row.id === seeded.activeEntitlement._id.toString(),
      );
      expect(withoutAttempts.attempts).toEqual({ used: 0, max: 3, remaining: 3 });

      const startedAt = new Date();
      await AttemptModel.create({
        studentId: seeded.studentId,
        testSeriesId: pdf.id,
        entitlementId: seeded.activeEntitlement._id,
        status: 'SUBMITTED',
        startedAt,
        examEndsAt: addDays(startedAt, 1),
        submittedAt: startedAt,
        attemptNumber: 1,
        version: 1,
        configurationSnapshot: { duration: 3600, maxScore: 100 },
      });

      const detail = await request(app)
        .get(`/admin/entitlements/${seeded.activeEntitlement._id.toString()}`)
        .set(bearer(adminToken));
      expect(detail.status).toBe(200);
      expect(detail.body.data.attempts).toEqual({ used: 1, max: 3, remaining: 2 });
    });

    it('reports unlimited attempts for free MCQ entitlements', async () => {
      const app = createApp();
      const { mcq, adminToken } = await seedCatalog(app);
      const student = await userRepository.findByEmail('student@example.com');
      const entitlement = await ensureFreeMcqEntitlement(student!._id.toString(), mcq.id);

      const detail = await request(app)
        .get(`/admin/entitlements/${entitlement.id}`)
        .set(bearer(adminToken));
      expect(detail.status).toBe(200);
      expect(detail.body.data.attempts).toEqual({ used: 0, max: null, remaining: null });
    });

    it('returns admin purchase and entitlement detail, and 404 for unknown ids', async () => {
      const app = createApp();
      const { pdf, adminToken } = await seedCatalog(app);
      const seeded = await seedAdminCommerceRows(pdf.id);

      const purchase = await request(app)
        .get(`/admin/purchases/${seeded.paid._id.toString()}`)
        .set(bearer(adminToken));
      expect(purchase.status).toBe(200);
      expect(purchase.body.data.razorpayPaymentId).toBe('pay_paid');

      const entitlement = await request(app)
        .get(`/admin/entitlements/${seeded.activeEntitlement._id.toString()}`)
        .set(bearer(adminToken));
      expect(entitlement.status).toBe(200);
      expect(entitlement.body.data.purchaseId).toBe(seeded.paid._id.toString());

      const missingPurchase = await request(app)
        .get(`/admin/purchases/${missingId}`)
        .set(bearer(adminToken));
      expect(missingPurchase.status).toBe(404);

      const missingEntitlement = await request(app)
        .get(`/admin/entitlements/${missingId}`)
        .set(bearer(adminToken));
      expect(missingEntitlement.status).toBe(404);
    });

    it('denies admin commerce detail reads to non-admins', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const { pdf } = await seedCatalog(app);
      const seeded = await seedAdminCommerceRows(pdf.id);

      const purchase = await request(app)
        .get(`/admin/purchases/${seeded.paid._id.toString()}`)
        .set(bearer(studentToken));
      expect(purchase.status).toBe(403);

      const entitlement = await request(app)
        .get(`/admin/entitlements/${seeded.activeEntitlement._id.toString()}`)
        .set(bearer(studentToken));
      expect(entitlement.status).toBe(403);

      const unauthenticated = await request(app).get('/admin/entitlements');
      expect(unauthenticated.status).toBe(401);
    });
  });
});
