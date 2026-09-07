import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
import { CategoryModel } from '../src/database/models/category.model';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { EvaluationRevisionModel } from '../src/database/models/evaluation-revision.model';
import { EvaluatorCategoryAssignmentModel } from '../src/database/models/evaluator-category-assignment.model';
import { HttpIdempotencyKeyModel } from '../src/database/models/http-idempotency-key.model';
import { ModuleModel } from '../src/database/models/module.model';
import { PurchaseModel } from '../src/database/models/purchase.model';
import { QuestionModel } from '../src/database/models/question.model';
import { ResultModel } from '../src/database/models/result.model';
import { SubmissionFileModel } from '../src/database/models/submission-file.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { WebhookEventModel } from '../src/database/models/webhook-event.model';
import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../src/database/models/conventions';
import { evaluatorCategoryAssignmentRepository } from '../src/database/repositories/assignments.repository';
import { userRepository } from '../src/database/repositories/user.repository';
import { setBlobStoreForTests } from '../src/integrations/blob/blob.operations';
import {
  resetRazorpayClientForTests,
  signPaymentVerification,
  signWebhookPayload,
} from '../src/integrations/razorpay/index';
import { hashPassword } from '../src/modules/auth/password';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { createMemoryBlobStore, putMemoryBlob, resetMemoryBlob } from './helpers/blob-memory';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const RAZORPAY_KEY_ID = 'rzp_test_key';
const RAZORPAY_KEY_SECRET = 'rzp_test_secret';
const RAZORPAY_WEBHOOK_SECRET = 'whsec_test_secret';
const PRICE_PAISE = 49900;
const mcqScoring = { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 };

type App = ReturnType<typeof createApp>;

const { sendEmailSpy } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn(),
}));

vi.mock('../src/modules/notifications/email.service', () => ({
  sendEmail: sendEmailSpy,
}));

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

function bearer(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-exam-session-id': '11111111-1111-4111-8111-111111111111',
  };
}

function purchaseHeaders(token: string, key = randomUUID()) {
  return { ...bearer(token), 'Idempotency-Key': key };
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function pdfBytes(extra = 'content'): Buffer {
  return Buffer.from(`%PDF-1.4\n${extra}\n%%EOF\n`);
}

function emailsWithSubject(subject: string) {
  return sendEmailSpy.mock.calls
    .map((call) => call[0] as { to?: string; subject?: string; text?: string; html?: string })
    .filter((email) => email.subject === subject);
}

async function seedUsers(): Promise<void> {
  await userRepository.create({
    email: 'student@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'STUDENT',
    status: 'ACTIVE',
    name: { first: 'Stu', last: 'Dent' },
  });
  await userRepository.create({
    email: 'evaluator@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'EVALUATOR',
    status: 'ACTIVE',
    name: { first: 'Eva', last: 'Luator' },
  });
  await userRepository.create({
    email: 'evaluator2@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'EVALUATOR',
    status: 'ACTIVE',
    name: { first: 'Other', last: 'Evaluator' },
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

async function userIdFor(email: string): Promise<string> {
  const user = await userRepository.findByEmail(email);
  expect(user).toBeTruthy();
  return user!._id.toString();
}

describe('Phase 24 V1 email notifications', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await ModuleModel.createIndexes();
    await TestSeriesModel.createIndexes();
    await QuestionModel.createIndexes();
    await PurchaseModel.createIndexes();
    await EntitlementModel.createIndexes();
    await AttemptModel.createIndexes();
    await SubmissionModel.createIndexes();
    await SubmissionFileModel.createIndexes();
    await EvaluationModel.createIndexes();
    await EvaluationRevisionModel.createIndexes();
    await EvaluatorCategoryAssignmentModel.createIndexes();
    await ResultModel.createIndexes();
    await WebhookEventModel.createIndexes();
    await HttpIdempotencyKeyModel.createIndexes();
  }, 120_000);

  afterAll(async () => {
    await stopMemoryMongo();
  });

  beforeEach(async () => {
    sendEmailSpy.mockReset();
    sendEmailSpy.mockResolvedValue(undefined);
    resetConfigForTests();
    resetRazorpayClientForTests();
    resetLoggerForTests();
    resetMemoryBlob();
    setBlobStoreForTests(createMemoryBlobStore());
    createOrderMock.mockReset();
    fetchPaymentMock.mockReset();
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: TEST_SECRET,
      JWT_ACCESS_TOKEN_TTL: '2h',
      RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET,
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test',
      PASSWORD_RESET_URL_BASE: 'http://localhost:5173/reset-password',
    });
    await seedUsers();
  });

  afterEach(async () => {
    setBlobStoreForTests(null);
    resetMemoryBlob();
    await clearMemoryMongo();
  });

  async function seedCatalog(app: App) {
    const adminToken = await login(app, 'admin@example.com');
    const category = await request(app)
      .post('/admin/categories')
      .set(bearer(adminToken))
      .send({ name: 'Mathematics' });
    const module = await request(app)
      .post('/admin/modules')
      .set(bearer(adminToken))
      .send({ categoryId: category.body.data.id, name: 'Algebra' });
    const mcq = await request(app).post('/admin/test-series').set(bearer(adminToken)).send({
      moduleId: module.body.data.id,
      title: 'MCQ Series',
      type: 'MCQ',
      duration: 3600,
      scoring: mcqScoring,
    });
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
        access: { isFree: false, price: PRICE_PAISE, currency: 'INR' },
      });
    const question = await request(app)
      .post('/admin/questions')
      .set(bearer(adminToken))
      .send({
        testSeriesId: mcq.body.data.id,
        position: 1,
        questionText: '2 + 2?',
        content: {
          options: [
            { id: 'A', text: '3' },
            { id: 'B', text: '4' },
          ],
          correctOptionId: 'B',
        },
      });
    const editorQuestion = await request(app)
      .post('/admin/questions')
      .set(bearer(adminToken))
      .send({
        testSeriesId: editor.body.data.id,
        position: 1,
        questionText: 'Explain.',
        content: {},
      });
    expect(category.status).toBe(201);
    expect(mcq.status).toBe(201);
    expect(pdf.status).toBe(201);
    expect(question.status).toBe(201);
    expect(editorQuestion.status).toBe(201);

    return {
      adminToken,
      categoryId: category.body.data.id as string,
      mcq: mcq.body.data as { id: string; title: string },
      pdf: pdf.body.data as { id: string; title: string },
      editor: editor.body.data as { id: string; title: string },
      mcqQuestionId: question.body.data.id as string,
    };
  }

  async function grantPaidEntitlement(studentId: string, testSeriesId: string) {
    const grantedAt = new Date();
    return EntitlementModel.create({
      studentId,
      testSeriesId,
      purchaseId: new Types.ObjectId(),
      status: 'ACTIVE',
      grantedAt,
      expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
    });
  }

  async function createPendingPurchase(app: App, studentToken: string, testSeriesId: string) {
    createOrderMock.mockResolvedValue({
      id: `order_${randomUUID()}`,
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

  async function verifyPurchase(
    app: App,
    studentToken: string,
    checkout: { purchaseId: string; razorpayOrderId: string },
  ) {
    const paymentId = `pay_${randomUUID()}`;
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
    return request(app).post('/payments/verify').set(bearer(studentToken)).send({
      purchaseId: checkout.purchaseId,
      razorpayOrderId: checkout.razorpayOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signature,
    });
  }

  async function sendCapturedWebhook(
    app: App,
    checkout: { razorpayOrderId: string },
    eventId = `evt_${randomUUID()}`,
  ) {
    const payload = {
      entity: 'event',
      account_id: 'acc_test',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: `pay_${eventId}`,
            order_id: checkout.razorpayOrderId,
            amount: PRICE_PAISE,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
    const rawBody = JSON.stringify(payload);
    return request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Event-Id', eventId)
      .set('X-Razorpay-Signature', signWebhookPayload(rawBody, RAZORPAY_WEBHOOK_SECRET))
      .send(rawBody);
  }

  async function submitMcq(app: App, catalog: Awaited<ReturnType<typeof seedCatalog>>) {
    const studentToken = await login(app, 'student@example.com');
    const started = await request(app)
      .post('/attempts')
      .set(bearer(studentToken))
      .send({ testSeriesId: catalog.mcq.id });
    expect(started.status).toBe(201);
    await request(app)
      .patch(`/attempts/${started.body.data.id}/answers`)
      .set(bearer(studentToken))
      .send({
        version: 1,
        answers: [{ questionId: catalog.mcqQuestionId, selectedOptionId: 'B' }],
      });
    const submitted = await request(app)
      .post(`/attempts/${started.body.data.id}/submit`)
      .set(bearer(studentToken));
    expect(submitted.status).toBe(200);
    return { studentToken, started, submitted };
  }

  async function submitPdf(app: App, catalog: Awaited<ReturnType<typeof seedCatalog>>) {
    const studentToken = await login(app, 'student@example.com');
    await grantPaidEntitlement(await userIdFor('student@example.com'), catalog.pdf.id);
    const started = await request(app)
      .post('/attempts')
      .set(bearer(studentToken))
      .send({ testSeriesId: catalog.pdf.id });
    expect(started.status).toBe(201);
    await AttemptModel.findByIdAndUpdate(started.body.data.id, {
      examEndsAt: new Date(Date.now() - 1000),
    });
    const pending = await request(app)
      .get(`/me/attempts/${started.body.data.id}`)
      .set(bearer(studentToken));
    expect(pending.body.data.status).toBe('UPLOAD_PENDING');
    const body = pdfBytes('student-answer');
    const authorized = await request(app)
      .post(`/attempts/${started.body.data.id}/upload-url`)
      .set(bearer(studentToken))
      .send({
        originalName: 'answer.pdf',
        contentType: 'application/pdf',
        sizeBytes: body.length,
      });
    const fileId = authorized.body.data.fileId as string;
    const stored = await SubmissionFileModel.findById(fileId);
    putMemoryBlob(stored!.storageLocator, body, 'application/pdf');
    await request(app).post(`/files/${fileId}/complete`).set(bearer(studentToken)).send({});
    const submitted = await request(app)
      .post(`/attempts/${started.body.data.id}/submit`)
      .set(bearer(studentToken));
    expect(submitted.status).toBe(200);
    return { studentToken, started, submitted };
  }

  it('does not expose a notification send API', async () => {
    const app = createApp();
    const response = await request(app).post('/notifications/send').send({
      to: 'attacker@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  describe('PURCHASE_SUCCESSFUL', () => {
    it('sends one student email after verified payment and entitlement grant', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const checkout = await createPendingPurchase(app, studentToken, catalog.pdf.id);
      expect(emailsWithSubject('Your Xplooreze purchase is confirmed')).toHaveLength(0);

      const verified = await verifyPurchase(app, studentToken, checkout);
      expect(verified.status).toBe(200);
      expect(verified.body.data.purchase.status).toBe('PAID');
      expect(verified.body.data.entitlement.status).toBe('ACTIVE');

      const emails = emailsWithSubject('Your Xplooreze purchase is confirmed');
      expect(emails).toHaveLength(1);
      expect(emails[0]?.to).toBe('student@example.com');
      expect(emails[0]?.text).toContain('PDF Series');
      expect(emails[0]?.text).toContain('INR 499.00');
      expect(emails[0]?.text).not.toContain(RAZORPAY_KEY_SECRET);
      expect(emails[0]?.text).not.toContain('razorpaySignature');
    });

    it('does not send on PENDING creation, failed payment, or invalid verification', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const checkout = await createPendingPurchase(app, studentToken, catalog.pdf.id);

      const invalid = await request(app).post('/payments/verify').set(bearer(studentToken)).send({
        purchaseId: checkout.purchaseId,
        razorpayOrderId: checkout.razorpayOrderId,
        razorpayPaymentId: 'pay_bad',
        razorpaySignature: 'deadbeef',
      });
      expect(invalid.status).toBe(400);

      const failedPayload = {
        entity: 'event',
        account_id: 'acc_test',
        event: 'payment.failed',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_fail',
              order_id: checkout.razorpayOrderId,
              amount: PRICE_PAISE,
              currency: 'INR',
              status: 'failed',
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      };
      const rawBody = JSON.stringify(failedPayload);
      const failed = await request(app)
        .post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Event-Id', 'evt_fail')
        .set('X-Razorpay-Signature', signWebhookPayload(rawBody, RAZORPAY_WEBHOOK_SECRET))
        .send(rawBody);
      expect(failed.status).toBe(200);
      expect((await PurchaseModel.findById(checkout.purchaseId))?.status).toBe('FAILED');
      expect(emailsWithSubject('Your Xplooreze purchase is confirmed')).toHaveLength(0);
    });

    it('does not duplicate email for verify replay, webhook replay, verify/webhook race, or purchase HTTP idempotency', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const idempotencyKey = randomUUID();
      createOrderMock.mockResolvedValue({
        id: 'order_idem',
        amount: PRICE_PAISE,
        currency: 'INR',
      });
      const firstCreate = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, idempotencyKey))
        .send({ testSeriesId: catalog.pdf.id });
      const replayCreate = await request(app)
        .post('/purchases')
        .set(purchaseHeaders(studentToken, idempotencyKey))
        .send({ testSeriesId: catalog.pdf.id });
      expect(firstCreate.status).toBe(201);
      expect(replayCreate.status).toBe(201);
      expect(replayCreate.body.data.purchaseId).toBe(firstCreate.body.data.purchaseId);
      expect(emailsWithSubject('Your Xplooreze purchase is confirmed')).toHaveLength(0);

      const checkout = await createPendingPurchase(app, studentToken, catalog.pdf.id);
      const paymentId = 'pay_race';
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

      const [verified, webhook] = await Promise.all([
        request(app).post('/payments/verify').set(bearer(studentToken)).send({
          purchaseId: checkout.purchaseId,
          razorpayOrderId: checkout.razorpayOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
        }),
        sendCapturedWebhook(app, checkout, 'evt_race'),
      ]);
      expect(verified.status).toBe(200);
      expect(webhook.status).toBe(200);

      const replayVerify = await request(app)
        .post('/payments/verify')
        .set(bearer(studentToken))
        .send({
          purchaseId: checkout.purchaseId,
          razorpayOrderId: checkout.razorpayOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
        });
      const replayWebhook = await sendCapturedWebhook(app, checkout, 'evt_race');
      expect(replayVerify.status).toBe(200);
      expect(replayWebhook.status).toBe(200);

      expect(emailsWithSubject('Your Xplooreze purchase is confirmed')).toHaveLength(1);
      expect((await PurchaseModel.findById(checkout.purchaseId))?.status).toBe('PAID');
    });

    it('keeps Purchase PAID and entitlement granted when email delivery fails', async () => {
      sendEmailSpy.mockRejectedValue(new Error('SMTP unavailable'));
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const checkout = await createPendingPurchase(app, studentToken, catalog.pdf.id);
      const verified = await verifyPurchase(app, studentToken, checkout);

      expect(verified.status).toBe(200);
      expect(verified.body.data.purchase.status).toBe('PAID');
      expect(verified.body.data.entitlement.status).toBe('ACTIVE');
      expect((await PurchaseModel.findById(checkout.purchaseId))?.status).toBe('PAID');
      expect(await EntitlementModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
    });
  });

  describe('ATTEMPT_SUBMITTED', () => {
    it('sends a student email after successful submission and not after autosave', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      const autosaved = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestionId, selectedOptionId: 'B' }],
        });
      expect(autosaved.status).toBe(200);
      expect(emailsWithSubject('Your Xplooreze attempt has been submitted')).toHaveLength(0);

      const submitted = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);

      const emails = emailsWithSubject('Your Xplooreze attempt has been submitted');
      expect(emails).toHaveLength(1);
      expect(emails[0]?.to).toBe('student@example.com');
      expect(emails[0]?.text).toContain('MCQ Series');
      expect(emails[0]?.text).not.toContain(catalog.mcqQuestionId);
      expect(emails[0]?.text).not.toContain('selectedOptionId');
      expect(emails[0]?.text).not.toContain('B');
    });

    it('does not send on failed PDF submit or duplicate submit', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await userIdFor('student@example.com'), catalog.pdf.id);
      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      await AttemptModel.findByIdAndUpdate(started.body.data.id, {
        examEndsAt: new Date(Date.now() - 1000),
      });
      await request(app).get(`/me/attempts/${started.body.data.id}`).set(bearer(studentToken));
      const failed = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(failed.status).toBe(409);
      expect(emailsWithSubject('Your Xplooreze attempt has been submitted')).toHaveLength(0);

      const body = pdfBytes('student-answer');
      const authorized = await request(app)
        .post(`/attempts/${started.body.data.id}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'answer.pdf',
          contentType: 'application/pdf',
          sizeBytes: body.length,
        });
      const fileId = authorized.body.data.fileId as string;
      const stored = await SubmissionFileModel.findById(fileId);
      putMemoryBlob(stored!.storageLocator, body, 'application/pdf');
      await request(app).post(`/files/${fileId}/complete`).set(bearer(studentToken)).send({});
      const submitted = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      expect(emailsWithSubject('Your Xplooreze attempt has been submitted')).toHaveLength(1);

      const duplicate = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(duplicate.status).toBe(200);
      expect(emailsWithSubject('Your Xplooreze attempt has been submitted')).toHaveLength(1);
      expect(emailsWithSubject('Your Xplooreze attempt has been submitted')[0]?.text).not.toContain(
        'blob',
      );
    });

    it('does not undo submission when email delivery fails', async () => {
      sendEmailSpy.mockRejectedValue(new Error('SMTP unavailable'));
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { submitted } = await submitMcq(app, catalog);
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');
      expect(await SubmissionModel.countDocuments({})).toBe(1);
    });
  });

  describe('RESULT_PUBLISHED', () => {
    it('sends student email on first publication using finalized Result fields', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await submitMcq(app, catalog);

      const emails = emailsWithSubject('Your Xplooreze result is available');
      expect(emails).toHaveLength(1);
      expect(emails[0]?.to).toBe('student@example.com');
      const result = await ResultModel.findOne({});
      expect(result?.status).toBe('PUBLISHED');
      expect(emails[0]?.text).toContain(`${result!.score} / ${result!.maxScore}`);
      expect(emails[0]?.text).toContain(`${result!.percentage}%`);
      expect(emails[0]?.text).not.toContain('evaluator');
    });

    it('does not send while a manual revision is in progress and does not resend after re-evaluation update', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await evaluatorCategoryAssignmentRepository.create({
        evaluatorId: await userIdFor('evaluator@example.com'),
        categoryId: catalog.categoryId,
        isActive: true,
      });
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const { submitted } = await submitPdf(app, catalog);
      const listed = await request(app).get('/admin/evaluations').set(bearer(catalog.adminToken));
      const evaluationId = (listed.body.data as Array<{ id: string; submissionId: string }>).find(
        (item) => item.submissionId === submitted.body.data.submissionId,
      )!.id;

      expect(emailsWithSubject('Your Xplooreze result is available')).toHaveLength(0);

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await userIdFor('evaluator@example.com') });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 80 });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      expect(emailsWithSubject('Your Xplooreze result is available')).toHaveLength(0);

      const finalized = await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));
      expect(finalized.status).toBe(200);
      expect(emailsWithSubject('Your Xplooreze result is available')).toHaveLength(1);
      expect(emailsWithSubject('Your Xplooreze result is available')[0]?.text).toContain('80');

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(catalog.adminToken));
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await userIdFor('evaluator@example.com') });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 92 });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      expect(emailsWithSubject('Your Xplooreze result is available')).toHaveLength(1);

      const refinalized = await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));
      expect(refinalized.status).toBe(200);
      expect((await ResultModel.findOne({}))!.score).toBe(92);
      expect(emailsWithSubject('Your Xplooreze result is available')).toHaveLength(1);
    });

    it('does not undo publication when email delivery fails', async () => {
      sendEmailSpy.mockRejectedValue(new Error('SMTP unavailable'));
      const app = createApp();
      const catalog = await seedCatalog(app);
      await submitMcq(app, catalog);
      const result = await ResultModel.findOne({});
      expect(result?.status).toBe('PUBLISHED');
    });
  });

  describe('EVALUATION_ASSIGNED', () => {
    it('sends email to the assigned evaluator and not to an unrelated evaluator', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await evaluatorCategoryAssignmentRepository.create({
        evaluatorId: await userIdFor('evaluator@example.com'),
        categoryId: catalog.categoryId,
        isActive: true,
      });
      await evaluatorCategoryAssignmentRepository.create({
        evaluatorId: await userIdFor('evaluator2@example.com'),
        categoryId: catalog.categoryId,
        isActive: true,
      });
      const { submitted } = await submitPdf(app, catalog);
      const listed = await request(app).get('/admin/evaluations').set(bearer(catalog.adminToken));
      const evaluationId = (listed.body.data as Array<{ id: string; submissionId: string }>).find(
        (item) => item.submissionId === submitted.body.data.submissionId,
      )!.id;

      const assigned = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await userIdFor('evaluator@example.com') });
      expect(assigned.status).toBe(200);

      const emails = emailsWithSubject('A Xplooreze evaluation has been assigned to you');
      expect(emails).toHaveLength(1);
      expect(emails[0]?.to).toBe('evaluator@example.com');
      expect(emails[0]?.text).toContain('PDF Series');
      expect(emails[0]?.text).toContain('Mathematics');
      expect(emails[0]?.text).not.toContain('student@example.com');
      expect(emails[0]?.html).not.toContain('href=');

      const duplicate = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await userIdFor('evaluator@example.com') });
      expect(duplicate.status).toBe(200);
      expect(emailsWithSubject('A Xplooreze evaluation has been assigned to you')).toHaveLength(1);
    });

    it('does not send for inactive category membership or starting evaluation', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await evaluatorCategoryAssignmentRepository.create({
        evaluatorId: await userIdFor('evaluator@example.com'),
        categoryId: catalog.categoryId,
        isActive: false,
      });
      const { submitted } = await submitPdf(app, catalog);
      const listed = await request(app).get('/admin/evaluations').set(bearer(catalog.adminToken));
      const evaluationId = (listed.body.data as Array<{ id: string; submissionId: string }>).find(
        (item) => item.submissionId === submitted.body.data.submissionId,
      )!.id;

      const rejected = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await userIdFor('evaluator@example.com') });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(emailsWithSubject('A Xplooreze evaluation has been assigned to you')).toHaveLength(0);

      await EvaluatorCategoryAssignmentModel.updateOne(
        { evaluatorId: await userIdFor('evaluator@example.com') },
        { $set: { isActive: true } },
      );
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await userIdFor('evaluator@example.com') });
      expect(emailsWithSubject('A Xplooreze evaluation has been assigned to you')).toHaveLength(1);

      const evaluatorToken = await login(app, 'evaluator@example.com');
      const started = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      expect(started.status).toBe(200);
      expect(emailsWithSubject('A Xplooreze evaluation has been assigned to you')).toHaveLength(1);
    });

    it('does not undo assignment when email delivery fails', async () => {
      sendEmailSpy.mockRejectedValue(new Error('SMTP unavailable'));
      const app = createApp();
      const catalog = await seedCatalog(app);
      await evaluatorCategoryAssignmentRepository.create({
        evaluatorId: await userIdFor('evaluator@example.com'),
        categoryId: catalog.categoryId,
        isActive: true,
      });
      const { submitted } = await submitPdf(app, catalog);
      const listed = await request(app).get('/admin/evaluations').set(bearer(catalog.adminToken));
      const evaluationId = (listed.body.data as Array<{ id: string; submissionId: string }>).find(
        (item) => item.submissionId === submitted.body.data.submissionId,
      )!.id;
      const assigned = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await userIdFor('evaluator@example.com') });
      expect(assigned.status).toBe(200);
      expect(assigned.body.data.status).toBe('ASSIGNED');
    });
  });
});
