import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
import { AuditLogModel } from '../src/database/models/audit-log.model';
import { CategoryModel } from '../src/database/models/category.model';
import {
  PAID_ENTITLEMENT_VALIDITY_DAYS,
  PDF_UPLOAD_GRACE_SECONDS,
} from '../src/database/models/conventions';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { EvaluationRevisionModel } from '../src/database/models/evaluation-revision.model';
import { ModuleModel } from '../src/database/models/module.model';
import { QuestionModel } from '../src/database/models/question.model';
import { SubmissionFileModel } from '../src/database/models/submission-file.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { setBlobStoreForTests } from '../src/integrations/blob/blob.operations';
import { hashPassword } from '../src/modules/auth/password';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';
import { createMemoryBlobStore, putMemoryBlob, resetMemoryBlob } from './helpers/blob-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const PRICE_PAISE = 49900;
const mcqScoring = { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 };

type App = ReturnType<typeof createApp>;

function pdfBytes(extra = 'content'): Buffer {
  return Buffer.from(`%PDF-1.4\n${extra}\n%%EOF\n`);
}

function bearer(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-exam-session-id': '11111111-1111-4111-8111-111111111111',
  };
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function mcqContent(correctOptionId = 'B') {
  return {
    options: [
      { id: 'A', text: '3' },
      { id: 'B', text: '4' },
      { id: 'C', text: '5' },
    ],
    correctOptionId,
  };
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

describe('Phase 20 Attempt lifecycle rules', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await ModuleModel.createIndexes();
    await TestSeriesModel.createIndexes();
    await QuestionModel.createIndexes();
    await EntitlementModel.createIndexes();
    await AttemptModel.createIndexes();
    await SubmissionModel.createIndexes();
    await SubmissionFileModel.createIndexes();
    await EvaluationModel.createIndexes();
    await EvaluationRevisionModel.createIndexes();
    await AuditLogModel.createIndexes();
  }, 120_000);

  afterAll(async () => {
    await stopMemoryMongo();
  });

  beforeEach(async () => {
    resetConfigForTests();
    resetLoggerForTests();
    resetMemoryBlob();
    setBlobStoreForTests(createMemoryBlobStore());
    vi.useRealTimers();
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: TEST_SECRET,
      JWT_ACCESS_TOKEN_TTL: '2h',
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test',
    });
    await seedUsers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearMemoryMongo();
  });

  async function seedCatalog(app: App) {
    const adminToken = await login(app, 'admin@example.com');
    const category = await request(app)
      .post('/admin/categories')
      .set(bearer(adminToken))
      .send({ name: 'Mathematics' });
    expect(category.status).toBe(201);

    const module = await request(app)
      .post('/admin/modules')
      .set(bearer(adminToken))
      .send({ categoryId: category.body.data.id, name: 'Algebra' });
    expect(module.status).toBe(201);

    const mcq = await request(app).post('/admin/test-series').set(bearer(adminToken)).send({
      moduleId: module.body.data.id,
      title: 'MCQ Series',
      type: 'MCQ',
      duration: 3600,
      scoring: mcqScoring,
    });
    expect(mcq.status).toBe(201);

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
    expect(editor.status).toBe(201);

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
    expect(pdf.status).toBe(201);

    const mcqQuestion = await request(app)
      .post('/admin/questions')
      .set(bearer(adminToken))
      .send({
        testSeriesId: mcq.body.data.id,
        position: 1,
        questionText: 'What is 2 + 2?',
        content: mcqContent('B'),
      });
    expect(mcqQuestion.status).toBe(201);

    const editorQuestion = await request(app)
      .post('/admin/questions')
      .set(bearer(adminToken))
      .send({
        testSeriesId: editor.body.data.id,
        position: 1,
        questionText: 'Explain derivatives.',
        content: {},
      });
    expect(editorQuestion.status).toBe(201);

    return {
      adminToken,
      mcq: mcq.body.data as { id: string },
      editor: editor.body.data as { id: string },
      pdf: pdf.body.data as { id: string },
      mcqQuestion: mcqQuestion.body.data as { id: string },
    };
  }

  async function grantPaidEntitlement(studentId: string, testSeriesId: string, expiresAt?: Date) {
    const grantedAt = new Date();
    return EntitlementModel.create({
      studentId,
      testSeriesId,
      purchaseId: new Types.ObjectId(),
      status: 'ACTIVE',
      grantedAt,
      expiresAt: expiresAt ?? addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
    });
  }

  async function studentIdFor(email: string): Promise<string> {
    const user = await userRepository.findByEmail(email);
    expect(user).toBeTruthy();
    return user!._id.toString();
  }

  async function authorizeAndStorePdf(app: App, studentToken: string, attemptId: string) {
    const body = pdfBytes('student-answer');
    const authorized = await request(app)
      .post(`/attempts/${attemptId}/upload-url`)
      .set(bearer(studentToken))
      .send({
        originalName: 'answer.pdf',
        contentType: 'application/pdf',
        sizeBytes: body.length,
      });
    expect(authorized.status).toBe(200);

    const fileId = authorized.body.data.fileId as string;
    const stored = await SubmissionFileModel.findById(fileId);
    putMemoryBlob(stored!.storageLocator, body, 'application/pdf');

    const completed = await request(app)
      .post(`/files/${fileId}/complete`)
      .set(bearer(studentToken))
      .send({});
    expect(completed.status).toBe(200);
    return fileId;
  }

  describe('PDF 5-minute upload grace', () => {
    it('snapshots uploadEndsAt as examEndsAt + 5 minutes and ignores client timer fields', async () => {
      const startedAt = new Date('2026-08-18T10:00:00.000Z');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(startedAt);

      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.pdf.id);

      const started = await request(app).post('/attempts').set(bearer(studentToken)).send({
        testSeriesId: catalog.pdf.id,
        uploadEndsAt: '2099-01-01T00:00:00.000Z',
        examEndsAt: '2099-01-01T00:00:00.000Z',
      });
      expect(started.status).toBe(400);

      const created = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(created.status).toBe(201);
      expect(created.body.data.examEndsAt).toBe('2026-08-18T11:00:00.000Z');
      expect(created.body.data.uploadEndsAt).toBe('2026-08-18T11:05:00.000Z');
      expect(created.body.data.configuration.pdfUploadGraceSeconds).toBe(PDF_UPLOAD_GRACE_SECONDS);

      const persisted = await AttemptModel.findById(created.body.data.id);
      expect(persisted!.uploadEndsAt!.toISOString()).toBe('2026-08-18T11:05:00.000Z');
      expect(persisted!.examEndsAt.toISOString()).toBe('2026-08-18T11:00:00.000Z');

      const extend = await request(app)
        .patch(`/attempts/${created.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          uploadEndsAt: '2099-01-01T00:00:00.000Z',
          editorDocument: { type: 'doc' },
        });
      expect(extend.status).toBe(400);

      const after = await AttemptModel.findById(created.body.data.id);
      expect(after!.uploadEndsAt!.toISOString()).toBe('2026-08-18T11:05:00.000Z');
    });

    it('does not give MCQ or EDITOR the PDF upload window', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.editor.id);

      const mcq = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(mcq.status).toBe(201);
      expect(mcq.body.data.uploadEndsAt).toBeNull();
      expect(mcq.body.data.configuration.pdfUploadGraceSeconds).toBeNull();

      const editor = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(editor.status).toBe(201);
      expect(editor.body.data.uploadEndsAt).toBeNull();
      expect(editor.body.data.configuration.pdfUploadGraceSeconds).toBeNull();
    });

    it('moves PDF to UPLOAD_PENDING at examEndsAt, allows upload for 5 minutes, then expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z'));

      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.pdf.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);
      const attemptId = started.body.data.id as string;
      const originalUploadEndsAt = started.body.data.uploadEndsAt as string;

      vi.setSystemTime(new Date('2026-08-18T11:00:00.000Z'));
      const pending = await request(app).get(`/me/attempts/${attemptId}`).set(bearer(studentToken));
      expect(pending.status).toBe(200);
      expect(pending.body.data.status).toBe('UPLOAD_PENDING');
      expect(pending.body.data.examEndsAt).toBe('2026-08-18T11:00:00.000Z');
      expect(pending.body.data.uploadEndsAt).toBe(originalUploadEndsAt);

      vi.setSystemTime(new Date('2026-08-18T11:04:59.000Z'));
      await authorizeAndStorePdf(app, studentToken, attemptId);

      vi.setSystemTime(new Date('2026-08-18T11:05:00.001Z'));
      const lateSubmit = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(lateSubmit.status).toBe(409);
      expect(lateSubmit.body.error.code).toBe(ErrorCodes.FILE_UPLOAD_EXPIRED);

      const lateUpload = await request(app)
        .post(`/attempts/${attemptId}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'late.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
        });
      expect(lateUpload.status).toBe(409);
      expect(lateUpload.body.error.code).toBe(ErrorCodes.FILE_UPLOAD_EXPIRED);

      const expired = await AttemptModel.findById(attemptId);
      expect(expired!.status).toBe('EXPIRED');
      expect(expired!.examEndsAt.toISOString()).toBe('2026-08-18T11:00:00.000Z');
      expect(['IN_PROGRESS', 'UPLOAD_PENDING', 'SUBMITTED', 'EXPIRED', 'CANCELLED']).toContain(
        expired!.status,
      );
    }, 20_000);
  });

  describe('entitlement expiry vs running Attempt', () => {
    it('keeps a running Attempt usable and still bound to examEndsAt', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z'));

      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      const entitlement = await grantPaidEntitlement(studentId, catalog.editor.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(started.status).toBe(201);
      const attemptId = started.body.data.id as string;
      const examEndsAt = started.body.data.examEndsAt as string;

      await EntitlementModel.findByIdAndUpdate(entitlement._id, {
        expiresAt: new Date('2026-08-18T10:10:00.000Z'),
      });

      vi.setSystemTime(new Date('2026-08-18T10:15:00.000Z'));
      const saved = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          editorDocument: { type: 'doc', content: [{ type: 'paragraph', text: 'still writing' }] },
        });
      expect(saved.status).toBe(200);
      expect(saved.body.data.status).toBe('IN_PROGRESS');
      expect(saved.body.data.examEndsAt).toBe(examEndsAt);

      const resumed = await request(app).get(`/me/attempts/${attemptId}`).set(bearer(studentToken));
      expect(resumed.status).toBe(200);
      expect(resumed.body.data.examEndsAt).toBe(examEndsAt);
      expect(resumed.body.data.remainingSeconds).toBe(2700);

      const submitted = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');

      const next = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(next.status).toBe(403);
      expect(next.body.error.code).toBe(ErrorCodes.ENTITLEMENT_EXPIRED);
    });
  });

  describe('account disablement vs running Attempt', () => {
    it('lets the current Attempt finish and blocks new protected work', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const adminToken = catalog.adminToken;
      const studentId = await studentIdFor('student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(started.status).toBe(201);
      const attemptId = started.body.data.id as string;

      const disabled = await request(app)
        .patch(`/admin/users/${studentId}`)
        .set(bearer(adminToken))
        .send({ status: 'DISABLED' });
      expect(disabled.status).toBe(200);
      expect(disabled.body.data.status).toBe('DISABLED');

      const me = await request(app).get('/auth/me').set(bearer(studentToken));
      expect(me.status).toBe(403);
      expect(me.body.error.code).toBe(ErrorCodes.ACCOUNT_DISABLED);

      const list = await request(app).get('/me/attempts').set(bearer(studentToken));
      expect(list.status).toBe(403);
      expect(list.body.error.code).toBe(ErrorCodes.ACCOUNT_DISABLED);

      const purchases = await request(app).get('/me/purchases').set(bearer(studentToken));
      expect(purchases.status).toBe(403);
      expect(purchases.body.error.code).toBe(ErrorCodes.ACCOUNT_DISABLED);

      const startAgain = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(startAgain.status).toBe(403);
      expect(startAgain.body.error.code).toBe(ErrorCodes.ACCOUNT_DISABLED);

      const current = await request(app).get(`/me/attempts/${attemptId}`).set(bearer(studentToken));
      expect(current.status).toBe(200);
      expect(current.body.data.status).toBe('IN_PROGRESS');

      const active = await request(app)
        .get('/me/attempts/active')
        .query({ testSeriesId: catalog.mcq.id })
        .set(bearer(studentToken));
      expect(active.status).toBe(200);
      expect(active.body.data.id).toBe(attemptId);

      const saved = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });
      expect(saved.status).toBe(200);
      expect(saved.body.data.status).toBe('IN_PROGRESS');

      const submitted = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');

      const persisted = await AttemptModel.findById(attemptId);
      expect(persisted!.status).toBe('SUBMITTED');
      expect(persisted!.status).not.toBe('CANCELLED');

      const reopen = await request(app).get(`/me/attempts/${attemptId}`).set(bearer(studentToken));
      expect(reopen.status).toBe(403);
      expect(reopen.body.error.code).toBe(ErrorCodes.ACCOUNT_DISABLED);

      const otherStart = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(otherStart.status).toBe(403);
      expect(await AttemptModel.countDocuments({})).toBe(1);
    });
  });

  describe('EDITOR rich-text-only scope', () => {
    it('accepts rich-text editorDocument and rejects execution-related fields', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.editor.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(started.status).toBe(201);

      const doc = { type: 'doc', content: [{ type: 'paragraph', text: 'essay' }] };
      const saved = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: doc });
      expect(saved.status).toBe(200);
      expect(saved.body.data.editorDocument).toEqual(doc);

      for (const field of [
        'code',
        'language',
        'testCases',
        'stdin',
        'stdout',
        'execution',
        'sandbox',
      ]) {
        const rejected = await request(app)
          .patch(`/attempts/${started.body.data.id}/answers`)
          .set(bearer(studentToken))
          .send({ version: 2, editorDocument: { type: 'doc', [field]: 'print(1)' } });
        expect(rejected.status).toBe(400);
      }

      const execute = await request(app)
        .post(`/attempts/${started.body.data.id}/execute`)
        .set(bearer(studentToken))
        .send({ language: 'python', stdin: '1' });
      expect(execute.status).toBe(404);
    });
  });
});
