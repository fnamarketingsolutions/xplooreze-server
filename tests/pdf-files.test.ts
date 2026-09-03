import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AnswerFileModel } from '../src/database/models/answer-file.model';
import { AttemptModel } from '../src/database/models/attempt.model';
import { AuditLogModel } from '../src/database/models/audit-log.model';
import { CategoryModel } from '../src/database/models/category.model';
import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../src/database/models/conventions';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { EvaluationRevisionModel } from '../src/database/models/evaluation-revision.model';
import { EvaluatorCategoryAssignmentModel } from '../src/database/models/evaluator-category-assignment.model';
import { ModuleModel } from '../src/database/models/module.model';
import { QuestionFileModel } from '../src/database/models/question-file.model';
import { QuestionModel } from '../src/database/models/question.model';
import { SubmissionFileModel } from '../src/database/models/submission-file.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { evaluatorCategoryAssignmentRepository } from '../src/database/repositories/assignments.repository';
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

type App = ReturnType<typeof createApp>;

function pdfBytes(extra = 'content'): Buffer {
  return Buffer.from(`%PDF-1.4\n${extra}\n%%EOF\n`);
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

async function userIdFor(email: string): Promise<string> {
  const user = await userRepository.findByEmail(email);
  expect(user).toBeTruthy();
  return user!._id.toString();
}

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

  const mcq = await request(app)
    .post('/admin/test-series')
    .set(bearer(adminToken))
    .send({
      moduleId: module.body.data.id,
      title: 'MCQ Series',
      type: 'MCQ',
      duration: 3600,
      scoring: { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 },
    });
  expect(mcq.status).toBe(201);

  const mcqQuestion = await request(app)
    .post('/admin/questions')
    .set(bearer(adminToken))
    .send({
      testSeriesId: mcq.body.data.id,
      position: 1,
      questionText: 'What is 2 + 2?',
      content: {
        options: [
          { id: 'A', text: '3' },
          { id: 'B', text: '4' },
        ],
        correctOptionId: 'B',
      },
    });
  expect(mcqQuestion.status).toBe(201);

  return {
    adminToken,
    categoryId: category.body.data.id as string,
    pdf: pdf.body.data as { id: string },
    mcq: mcq.body.data as { id: string },
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

async function assignCategory(evaluatorEmail: string, categoryId: string, isActive = true) {
  const evaluatorId = await userIdFor(evaluatorEmail);
  return evaluatorCategoryAssignmentRepository.create({
    evaluatorId,
    categoryId,
    isActive,
  });
}

async function uploadQuestionPaper(
  app: App,
  adminToken: string,
  testSeriesId: string,
  body = pdfBytes(),
) {
  const authRes = await request(app)
    .post(`/admin/test-series/${testSeriesId}/question-files/upload-url`)
    .set(bearer(adminToken))
    .send({ originalName: 'paper.pdf', contentType: 'application/pdf', sizeBytes: body.length });
  expect(authRes.status).toBe(200);
  const fileId = authRes.body.data.fileId as string;
  const stored = await QuestionFileModel.findById(fileId);
  expect(stored).toBeTruthy();
  putMemoryBlob(stored!.storageLocator, body, 'application/pdf');

  const completeRes = await request(app)
    .post(`/files/${fileId}/complete`)
    .set(bearer(adminToken))
    .send({});
  expect(completeRes.status).toBe(200);
  expect(completeRes.body.data.status).toBe('ACTIVE');

  return { fileId, stored: stored! };
}

async function uploadAnswerFile(
  app: App,
  adminToken: string,
  testSeriesId: string,
  body = pdfBytes('answer key'),
) {
  const authRes = await request(app)
    .post(`/admin/test-series/${testSeriesId}/answer-files/upload-url`)
    .set(bearer(adminToken))
    .send({ originalName: 'answers.pdf', contentType: 'application/pdf', sizeBytes: body.length });
  expect(authRes.status).toBe(200);
  const fileId = authRes.body.data.fileId as string;
  const stored = await AnswerFileModel.findById(fileId);
  expect(stored).toBeTruthy();
  putMemoryBlob(stored!.storageLocator, body, 'application/pdf');

  const completeRes = await request(app)
    .post(`/files/${fileId}/complete`)
    .set(bearer(adminToken))
    .send({});
  expect(completeRes.status).toBe(200);
  expect(completeRes.body.data.status).toBe('ACTIVE');

  return { fileId, stored: stored! };
}

async function submitPdfAttempt(app: App, catalog: Awaited<ReturnType<typeof seedCatalog>>) {
  const studentToken = await login(app, 'student@example.com');
  const studentId = await userIdFor('student@example.com');
  await grantPaidEntitlement(studentId, catalog.pdf.id);

  const started = await request(app)
    .post('/attempts')
    .set(bearer(studentToken))
    .send({ testSeriesId: catalog.pdf.id });
  expect(started.status).toBe(201);
  const attemptId = started.body.data.id as string;

  await AttemptModel.findByIdAndUpdate(attemptId, { examEndsAt: new Date(Date.now() - 1000) });
  const pending = await request(app).get(`/me/attempts/${attemptId}`).set(bearer(studentToken));
  expect(pending.body.data.status).toBe('UPLOAD_PENDING');

  const uploadAuth = await request(app)
    .post(`/attempts/${attemptId}/upload-url`)
    .set(bearer(studentToken))
    .send({
      originalName: 'answer.pdf',
      contentType: 'application/pdf',
      sizeBytes: pdfBytes().length,
    });
  expect(uploadAuth.status).toBe(200);
  const submFileId = uploadAuth.body.data.fileId as string;
  const submStored = await SubmissionFileModel.findById(submFileId);
  putMemoryBlob(submStored!.storageLocator, pdfBytes(), 'application/pdf');
  await request(app).post(`/files/${submFileId}/complete`).set(bearer(studentToken)).send({});

  const submitted = await request(app)
    .post(`/attempts/${attemptId}/submit`)
    .set(bearer(studentToken));
  expect(submitted.status).toBe(200);

  return {
    studentToken,
    studentId,
    attemptId,
    submissionId: submitted.body.data.submissionId as string,
  };
}

describe('Phase 18 — PDF Test Series file authoring', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await ModuleModel.createIndexes();
    await TestSeriesModel.createIndexes();
    await QuestionModel.createIndexes();
    await QuestionFileModel.createIndexes();
    await AnswerFileModel.createIndexes();
    await EntitlementModel.createIndexes();
    await AttemptModel.createIndexes();
    await SubmissionModel.createIndexes();
    await SubmissionFileModel.createIndexes();
    await EvaluationModel.createIndexes();
    await EvaluationRevisionModel.createIndexes();
    await EvaluatorCategoryAssignmentModel.createIndexes();
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
      BLOB_DOWNLOAD_URL_TTL_SECONDS: '45',
    });
    await seedUsers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    setBlobStoreForTests(null);
    resetMemoryBlob();
    await clearMemoryMongo();
  });

  // ── ADMIN: Question paper upload ─────────────────────────────────────────

  describe('Admin question-paper upload', () => {
    it('admin can request a question-paper upload URL for a PDF test series', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const adminToken = catalog.adminToken;

      const res = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/question-files/upload-url`)
        .set(bearer(adminToken))
        .send({ originalName: 'exam.pdf', contentType: 'application/pdf', sizeBytes: 1024 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fileId).toBeDefined();
      expect(res.body.data.uploadUrl).toMatch(/^https:\/\/blob\.test\/upload\//);
      expect(res.body.data.method).toBe('PUT');
      expect(res.body.data).not.toHaveProperty('storageLocator');
      expect(res.body.data).not.toHaveProperty('storageProvider');

      const created = await QuestionFileModel.findById(res.body.data.fileId);
      expect(created).toBeTruthy();
      expect(created!.status).toBe('PENDING');
      expect(created!.testSeriesId.toString()).toBe(catalog.pdf.id);
    });

    it('non-admin cannot upload a question paper', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const res = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/question-files/upload-url`)
        .set(bearer(studentToken))
        .send({ originalName: 'exam.pdf', contentType: 'application/pdf', sizeBytes: 1024 });

      expect(res.status).toBe(403);
    });

    it('unauthenticated request is rejected', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const res = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/question-files/upload-url`)
        .send({ originalName: 'exam.pdf', contentType: 'application/pdf', sizeBytes: 1024 });

      expect(res.status).toBe(401);
    });

    it('rejects non-PDF mime type for question paper', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const res = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/question-files/upload-url`)
        .set(bearer(catalog.adminToken))
        .send({ originalName: 'exam.docx', contentType: 'application/msword', sizeBytes: 1024 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED);
    });

    it('rejects question paper upload for non-PDF test series', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const res = await request(app)
        .post(`/admin/test-series/${catalog.mcq.id}/question-files/upload-url`)
        .set(bearer(catalog.adminToken))
        .send({ originalName: 'exam.pdf', contentType: 'application/pdf', sizeBytes: 1024 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('client cannot supply storageLocator or storageProvider in upload request', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const res = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/question-files/upload-url`)
        .set(bearer(catalog.adminToken))
        .send({
          originalName: 'exam.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          storageLocator: 'evil.pdf',
          storageProvider: 'VERCEL_BLOB',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });
  });

  describe('Admin question-paper complete upload', () => {
    it('admin can complete a valid question-paper upload', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);

      const file = await QuestionFileModel.findById(fileId);
      expect(file!.status).toBe('ACTIVE');
      expect(file!.testSeriesId.toString()).toBe(catalog.pdf.id);
    });

    it('completing with invalid PDF magic bytes fails', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const authRes = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/question-files/upload-url`)
        .set(bearer(catalog.adminToken))
        .send({ originalName: 'paper.pdf', contentType: 'application/pdf', sizeBytes: 100 });
      expect(authRes.status).toBe(200);

      const fileId = authRes.body.data.fileId as string;
      const stored = await QuestionFileModel.findById(fileId);
      putMemoryBlob(stored!.storageLocator, Buffer.from('not a pdf'), 'application/pdf');

      const completeRes = await request(app)
        .post(`/files/${fileId}/complete`)
        .set(bearer(catalog.adminToken))
        .send({});

      expect(completeRes.status).toBe(400);
      expect(completeRes.body.error.code).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED);

      const file = await QuestionFileModel.findById(fileId);
      expect(file!.status).toBe('PENDING');
    });

    it('replacing question paper activates the new paper and marks the old one as REPLACED', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const { fileId: firstId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('v1'),
      );
      const { fileId: secondId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('v2'),
      );

      const first = await QuestionFileModel.findById(firstId);
      const second = await QuestionFileModel.findById(secondId);

      expect(first!.status).toBe('REPLACED');
      expect(second!.status).toBe('ACTIVE');
    });

    it('admin completes question files through the unified complete endpoint', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const authRes = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/question-files/upload-url`)
        .set(bearer(catalog.adminToken))
        .send({ originalName: 'paper.pdf', contentType: 'application/pdf', sizeBytes: 100 });
      const fileId = authRes.body.data.fileId as string;
      const stored = await QuestionFileModel.findById(fileId);
      putMemoryBlob(stored!.storageLocator, pdfBytes(), 'application/pdf');

      const res = await request(app)
        .post(`/files/${fileId}/complete`)
        .set(bearer(catalog.adminToken))
        .send({});
      expect(res.status).toBe(200);
    });
  });

  // ── ADMIN: Answer file upload ─────────────────────────────────────────────

  describe('Admin answer-file upload', () => {
    it('admin can upload an answer/reference file', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const file = await AnswerFileModel.findById(fileId);
      expect(file!.status).toBe('ACTIVE');
      expect(file!.testSeriesId.toString()).toBe(catalog.pdf.id);
      expect(file!.toObject()).not.toHaveProperty('questionId');
    });

    it('non-admin cannot upload answer files', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const res = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/answer-files/upload-url`)
        .set(bearer(studentToken))
        .send({ originalName: 'key.pdf', contentType: 'application/pdf', sizeBytes: 100 });

      expect(res.status).toBe(403);
    });

    it('multiple answer files can be attached to a test series', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const { fileId: id1 } = await uploadAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('key1'),
      );
      const { fileId: id2 } = await uploadAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('key2'),
      );

      const f1 = await AnswerFileModel.findById(id1);
      const f2 = await AnswerFileModel.findById(id2);
      expect(f1!.status).toBe('ACTIVE');
      expect(f2!.status).toBe('ACTIVE');
      expect(f1!.toObject()).not.toHaveProperty('questionId');
      expect(f2!.toObject()).not.toHaveProperty('questionId');
    });
  });

  // ── ADMIN: List ACTIVE PDF files ──────────────────────────────────────────

  describe('Admin list question/answer files', () => {
    it('returns null when no ACTIVE question paper exists', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const res = await request(app)
        .get(`/admin/test-series/${catalog.pdf.id}/question-files`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeNull();
    });

    it('returns ACTIVE question paper metadata after complete', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);

      const res = await request(app)
        .get(`/admin/test-series/${catalog.pdf.id}/question-files`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: fileId,
        testSeriesId: catalog.pdf.id,
        status: 'ACTIVE',
        originalName: 'paper.pdf',
        mimeType: 'application/pdf',
      });
      expect(res.body.data).not.toHaveProperty('storageLocator');
      expect(res.body.data).not.toHaveProperty('downloadUrl');
    });

    it('returns empty array when no ACTIVE answer files exist', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const res = await request(app)
        .get(`/admin/test-series/${catalog.pdf.id}/answer-files`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('returns ACTIVE answer file metadata after complete', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId: id1 } = await uploadAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('key1'),
      );
      const { fileId: id2 } = await uploadAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('key2'),
      );

      const res = await request(app)
        .get(`/admin/test-series/${catalog.pdf.id}/answer-files`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
      const ids = res.body.data.map((f: { id: string }) => f.id);
      expect(ids).toEqual(expect.arrayContaining([id1, id2]));
      for (const item of res.body.data) {
        expect(item).toMatchObject({
          testSeriesId: catalog.pdf.id,
          status: 'ACTIVE',
          mimeType: 'application/pdf',
        });
        expect(item).not.toHaveProperty('storageLocator');
      }
    });

    it('omits logically deleted answer files from the list', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const del = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(del.status).toBe(200);

      const res = await request(app)
        .get(`/admin/test-series/${catalog.pdf.id}/answer-files`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('non-admin cannot list question or answer files', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const qp = await request(app)
        .get(`/admin/test-series/${catalog.pdf.id}/question-files`)
        .set(bearer(studentToken));
      expect(qp.status).toBe(403);

      const af = await request(app)
        .get(`/admin/test-series/${catalog.pdf.id}/answer-files`)
        .set(bearer(studentToken));
      expect(af.status).toBe(403);
    });

    it('rejects list on non-PDF test series', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const qp = await request(app)
        .get(`/admin/test-series/${catalog.mcq.id}/question-files`)
        .set(bearer(catalog.adminToken));
      expect(qp.status).toBe(400);
      expect(qp.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const af = await request(app)
        .get(`/admin/test-series/${catalog.mcq.id}/answer-files`)
        .set(bearer(catalog.adminToken));
      expect(af.status).toBe(400);
      expect(af.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });
  });

  // ── ATTEMPT SNAPSHOT ──────────────────────────────────────────────────────

  describe('Attempt snapshot — questionPaperFileId', () => {
    it('PDF attempt records the active question-paper file ID at start', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);
      expect(started.body.data.questionPaperFileId).not.toBeNull();

      const attempt = await AttemptModel.findById(started.body.data.id);
      expect(attempt!.questionPaperFileId).toBeTruthy();
    });

    it('PDF attempt without question paper has null questionPaperFileId', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);
      expect(started.body.data.questionPaperFileId).toBeNull();
    });

    it('replacing the question paper does not change an existing attempt snapshot', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId: originalPaperId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('v1'),
      );

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);
      expect(started.body.data.questionPaperFileId).toBe(originalPaperId);

      // Admin replaces the question paper
      await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id, pdfBytes('v2'));

      // The existing attempt still references the original paper
      const attempt = await AttemptModel.findById(started.body.data.id);
      expect(attempt!.questionPaperFileId!.toString()).toBe(originalPaperId);
    });

    it('new attempt after replacement uses the new ACTIVE question paper', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id, pdfBytes('v1'));

      const student1Token = await login(app, 'student@example.com');
      const student1Id = await userIdFor('student@example.com');
      await grantPaidEntitlement(student1Id, catalog.pdf.id);

      const firstAttempt = await request(app)
        .post('/attempts')
        .set(bearer(student1Token))
        .send({ testSeriesId: catalog.pdf.id });
      expect(firstAttempt.status).toBe(201);
      const firstPaperId = firstAttempt.body.data.questionPaperFileId as string;

      // Admin replaces paper
      const { fileId: newPaperId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('v2'),
      );

      const student2Token = await login(app, 'student2@example.com');
      const student2Id = await userIdFor('student2@example.com');
      await grantPaidEntitlement(student2Id, catalog.pdf.id);

      const secondAttempt = await request(app)
        .post('/attempts')
        .set(bearer(student2Token))
        .send({ testSeriesId: catalog.pdf.id });
      expect(secondAttempt.status).toBe(201);

      expect(secondAttempt.body.data.questionPaperFileId).toBe(newPaperId);
      expect(secondAttempt.body.data.questionPaperFileId).not.toBe(firstPaperId);
    });

    it('MCQ attempt does not have a questionPaperFileId', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const studentToken = await login(app, 'student@example.com');
      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(started.status).toBe(201);
      expect(started.body.data.questionPaperFileId).toBeNull();
    });
  });

  // ── STUDENT: question paper access ────────────────────────────────────────

  describe('Student question-paper access', () => {
    it('student with a valid attempt can download the ACTIVE question paper', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });

      const res = await request(app).get(`/files/${fileId}/download`).set(bearer(studentToken));

      expect(res.status).toBe(200);
      expect(res.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);
      expect(res.body.data).not.toHaveProperty('storageLocator');
      expect(Object.keys(res.body.data)).toEqual(['downloadUrl']);
    });

    it('student without an attempt cannot access the question paper', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);

      const studentToken = await login(app, 'student@example.com');

      const res = await request(app).get(`/files/${fileId}/download`).set(bearer(studentToken));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);
    });

    it('student cannot access a question paper from a different test series by fileId', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      // Create second PDF series
      const secondPdf = await request(app)
        .post('/admin/test-series')
        .set(bearer(catalog.adminToken))
        .send({
          moduleId: (
            await request(app)
              .post('/admin/modules')
              .set(bearer(catalog.adminToken))
              .send({ categoryId: catalog.categoryId, name: 'Geo' })
          ).body.data.id,
          title: 'Another PDF',
          type: 'PDF',
          duration: 1800,
          access: { isFree: false, price: PRICE_PAISE, currency: 'INR' },
        });
      expect(secondPdf.status).toBe(201);

      const { fileId: otherSeriesFileId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        secondPdf.body.data.id,
      );

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      // Student starts attempt for first series only
      await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });

      // Try to access question paper from second series
      const res = await request(app)
        .get(`/files/${otherSeriesFileId}/download`)
        .set(bearer(studentToken));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);
    });

    it('PENDING question paper cannot be downloaded', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const authRes = await request(app)
        .post(`/admin/test-series/${catalog.pdf.id}/question-files/upload-url`)
        .set(bearer(catalog.adminToken))
        .send({ originalName: 'paper.pdf', contentType: 'application/pdf', sizeBytes: 100 });
      const pendingFileId = authRes.body.data.fileId as string;

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);
      await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });

      const res = await request(app)
        .get(`/files/${pendingFileId}/download`)
        .set(bearer(studentToken));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);
    });

    it('owning student can download their historical REPLACED question paper', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId: oldId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('v1'),
      );

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);
      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);

      await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id, pdfBytes('v2'));

      const res = await request(app).get(`/files/${oldId}/download`).set(bearer(studentToken));

      expect(res.status).toBe(200);
      expect(res.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);
    });

    it('another student cannot download a historical REPLACED question paper they do not own', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId: oldId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('v1'),
      );

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);
      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);

      await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id, pdfBytes('v2'));

      const otherStudentToken = await login(app, 'student2@example.com');
      const otherStudentId = await userIdFor('student2@example.com');
      await grantPaidEntitlement(otherStudentId, catalog.pdf.id);

      const res = await request(app).get(`/files/${oldId}/download`).set(bearer(otherStudentToken));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);
    });

    it('student cannot access answer/reference files', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId: answerId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);
      await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });

      const res = await request(app).get(`/files/${answerId}/download`).set(bearer(studentToken));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);
    });

    it('download URL does not expose blob credentials', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);

      const studentToken = await login(app, 'student@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);
      await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });

      const res = await request(app).get(`/files/${fileId}/download`).set(bearer(studentToken));

      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('BLOB_READ_WRITE_TOKEN');
      expect(body).not.toContain('storageLocator');
      expect(body).not.toContain('storageProvider');
    });
  });

  // ── EVALUATOR: access ─────────────────────────────────────────────────────

  describe('Evaluator access to question/answer files', () => {
    it('assigned evaluator can access the question paper and answer file', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const { fileId: questionFileId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
      );
      const { fileId: answerFileId } = await uploadAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
      );

      const { submissionId } = await submitPdfAttempt(app, catalog);

      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluatorId = await userIdFor('evaluator@example.com');

      const evaluation = await EvaluationModel.findOne({ submissionId });
      expect(evaluation).toBeTruthy();

      // Unassigned evaluator cannot access
      const unassignedQ = await request(app)
        .get(`/files/${questionFileId}/download`)
        .set(bearer(evaluatorToken));
      expect(unassignedQ.status).toBe(403);

      const unassignedA = await request(app)
        .get(`/files/${answerFileId}/download`)
        .set(bearer(evaluatorToken));
      expect(unassignedA.status).toBe(403);

      // Admin assigns the evaluator
      await request(app)
        .post(`/admin/evaluations/${evaluation!._id.toString()}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });

      const allowedQ = await request(app)
        .get(`/files/${questionFileId}/download`)
        .set(bearer(evaluatorToken));
      expect(allowedQ.status).toBe(200);
      expect(allowedQ.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);

      const allowedA = await request(app)
        .get(`/files/${answerFileId}/download`)
        .set(bearer(evaluatorToken));
      expect(allowedA.status).toBe(200);
      expect(allowedA.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);
    });

    it('unassigned evaluator cannot access question or answer files', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const { fileId: questionFileId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
      );
      const { fileId: answerFileId } = await uploadAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
      );

      await submitPdfAttempt(app, catalog);

      const evaluatorToken = await login(app, 'evaluator@example.com');

      const resQ = await request(app)
        .get(`/files/${questionFileId}/download`)
        .set(bearer(evaluatorToken));
      expect(resQ.status).toBe(403);

      const resA = await request(app)
        .get(`/files/${answerFileId}/download`)
        .set(bearer(evaluatorToken));
      expect(resA.status).toBe(403);
    });

    it('inactive category assignment blocks evaluator file access', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const assignment = await assignCategory('evaluator@example.com', catalog.categoryId, true);
      const { fileId: questionFileId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
      );

      const { submissionId } = await submitPdfAttempt(app, catalog);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluatorId = await userIdFor('evaluator@example.com');
      const evaluation = await EvaluationModel.findOne({ submissionId });

      await request(app)
        .post(`/admin/evaluations/${evaluation!._id.toString()}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });

      await evaluatorCategoryAssignmentRepository.updateById(assignment._id, {
        $set: { isActive: false },
      });

      const res = await request(app)
        .get(`/files/${questionFileId}/download`)
        .set(bearer(evaluatorToken));
      expect(res.status).toBe(403);
    });
  });

  // ── ADMIN: file access ────────────────────────────────────────────────────

  describe('Admin file access', () => {
    it('admin can download an ACTIVE question paper', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);

      const res = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);
    });

    it('admin can download an ACTIVE answer file', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const res = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);
    });
  });

  // ── SECURITY ──────────────────────────────────────────────────────────────

  describe('Security boundaries', () => {
    it('client cannot override test series ownership via query params', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);
      const studentToken = await login(app, 'student@example.com');

      const res = await request(app)
        .get(`/files/${fileId}/download`)
        .query({ testSeriesId: catalog.pdf.id, studentId: 'evil' })
        .set(bearer(studentToken));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('Mongo operators are rejected in download query', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);
      const studentToken = await login(app, 'student@example.com');

      const res = await request(app)
        .get(`/files/${fileId}/download`)
        .query({ $gt: '' })
        .set(bearer(studentToken));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });
  });
});
