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
import {
  createMemoryBlobStore,
  getMemoryBlob,
  putMemoryBlob,
  resetMemoryBlob,
} from './helpers/blob-memory';

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

  return {
    adminToken,
    categoryId: category.body.data.id as string,
    pdf: pdf.body.data as { id: string; title: string; status: string },
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

async function assignCategory(evaluatorEmail: string, categoryId: string) {
  const evaluatorId = await userIdFor(evaluatorEmail);
  return evaluatorCategoryAssignmentRepository.create({
    evaluatorId,
    categoryId,
    isActive: true,
  });
}

async function createPendingAnswerFile(
  app: App,
  adminToken: string,
  testSeriesId: string,
  body = pdfBytes('pending-key'),
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
  return { fileId, stored: stored! };
}

async function uploadAnswerFile(
  app: App,
  adminToken: string,
  testSeriesId: string,
  body = pdfBytes('answer key'),
) {
  const pending = await createPendingAnswerFile(app, adminToken, testSeriesId, body);
  const completeRes = await request(app)
    .post(`/files/${pending.fileId}/complete`)
    .set(bearer(adminToken))
    .send({});
  expect(completeRes.status).toBe(200);
  expect(completeRes.body.data.status).toBe('ACTIVE');
  return pending;
}

async function uploadQuestionPaper(app: App, adminToken: string, testSeriesId: string) {
  const body = pdfBytes('paper');
  const authRes = await request(app)
    .post(`/admin/test-series/${testSeriesId}/question-files/upload-url`)
    .set(bearer(adminToken))
    .send({ originalName: 'paper.pdf', contentType: 'application/pdf', sizeBytes: body.length });
  expect(authRes.status).toBe(200);
  const fileId = authRes.body.data.fileId as string;
  const stored = await QuestionFileModel.findById(fileId);
  putMemoryBlob(stored!.storageLocator, body, 'application/pdf');
  const completeRes = await request(app)
    .post(`/files/${fileId}/complete`)
    .set(bearer(adminToken))
    .send({});
  expect(completeRes.status).toBe(200);
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
    submissionFileId: submFileId,
  };
}

function expectDownloadDenied(res: { status: number; body: { error?: { code?: string } } }) {
  expect([403, 404]).toContain(res.status);
  expect([ErrorCodes.FILE_NOT_ACCESSIBLE, ErrorCodes.FILE_NOT_FOUND]).toContain(
    res.body.error?.code,
  );
}

describe('Phase 21 — AnswerFile logical deletion', () => {
  let deleteObjectSpy: ReturnType<typeof vi.spyOn> | undefined;

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
    const store = createMemoryBlobStore();
    deleteObjectSpy = vi.spyOn(store, 'deleteObject');
    setBlobStoreForTests(store);
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
    deleteObjectSpy?.mockRestore();
    setBlobStoreForTests(null);
    resetMemoryBlob();
    await clearMemoryMongo();
  });

  describe('Authorization', () => {
    it('rejects unauthenticated requests', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const res = await request(app).delete(`/admin/answer-files/${fileId}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ErrorCodes.AUTHENTICATION_REQUIRED);
    });

    it('rejects Student requests', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);
      const studentToken = await login(app, 'student@example.com');

      const res = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(studentToken));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it('rejects Evaluator requests', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);
      const evaluatorToken = await login(app, 'evaluator@example.com');

      const res = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(evaluatorToken));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it('allows Admin requests', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const res = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(fileId);
      expect(res.body.data.status).toBe('DELETED');
    });
  });

  describe('Lifecycle', () => {
    it('transitions PENDING AnswerFile to DELETED', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId, stored } = await createPendingAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
      );
      const locator = stored.storageLocator;

      const res = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('DELETED');

      const after = await AnswerFileModel.findById(fileId);
      expect(after).toBeTruthy();
      expect(after!.status).toBe('DELETED');
      expect(after!.deletedAt).toBeTruthy();
      expect(after!.storageLocator).toBe(locator);
      expect(after!.originalName).toBe(stored.originalName);
      expect(after!.testSeriesId.toString()).toBe(catalog.pdf.id);
    });

    it('transitions ACTIVE AnswerFile to DELETED', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId, stored } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const res = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('DELETED');
      expect(res.body.data).not.toHaveProperty('storageLocator');
      expect(res.body.data).not.toHaveProperty('storageProvider');

      const after = await AnswerFileModel.findById(fileId);
      expect(after).toBeTruthy();
      expect(after!.status).toBe('DELETED');
      expect(after!.deletedAt).toBeTruthy();
      expect(after!.storageLocator).toBe(stored.storageLocator);
    });

    it('does not physically remove the MongoDB document', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      await request(app).delete(`/admin/answer-files/${fileId}`).set(bearer(catalog.adminToken));

      const count = await AnswerFileModel.countDocuments({ _id: fileId });
      expect(count).toBe(1);
    });

    it('treats repeated DELETE as already-deleted not-found without leaving DELETED', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId, stored } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const first = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(first.status).toBe(200);

      const second = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(second.status).toBe(404);
      expect(second.body.error.code).toBe(ErrorCodes.FILE_NOT_FOUND);

      const after = await AnswerFileModel.findById(fileId);
      expect(after!.status).toBe('DELETED');
      expect(after!.storageLocator).toBe(stored.storageLocator);
      expect(getMemoryBlob(stored.storageLocator)).toBeTruthy();
    });

    it('does not reactivate a DELETED file through complete upload', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await createPendingAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const deleted = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(deleted.status).toBe(200);

      const complete = await request(app)
        .post(`/files/${fileId}/complete`)
        .set(bearer(catalog.adminToken))
        .send({});
      expect(complete.status).toBe(404);
      expect(complete.body.error.code).toBe(ErrorCodes.FILE_NOT_FOUND);

      const after = await AnswerFileModel.findById(fileId);
      expect(after!.status).toBe('DELETED');
    });

    it('handles concurrent DELETE without leaving DELETED or deleting Blob', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId, stored } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const [first, second] = await Promise.all([
        request(app).delete(`/admin/answer-files/${fileId}`).set(bearer(catalog.adminToken)),
        request(app).delete(`/admin/answer-files/${fileId}`).set(bearer(catalog.adminToken)),
      ]);

      const statuses = [first.status, second.status];
      expect(statuses.every((status) => status === 200 || status === 404)).toBe(true);
      expect(statuses).toContain(200);

      const after = await AnswerFileModel.findById(fileId);
      expect(after!.status).toBe('DELETED');
      expect(after!.storageLocator).toBe(stored.storageLocator);
      expect(getMemoryBlob(stored.storageLocator)).toBeTruthy();
      expect(deleteObjectSpy).not.toHaveBeenCalled();
    });
  });

  describe('Storage', () => {
    it('does not delete the Blob object and leaves the storage locator unchanged', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId, stored } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);
      const locator = stored.storageLocator;
      expect(getMemoryBlob(locator)).toBeTruthy();

      const res = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(res.status).toBe(200);

      expect(deleteObjectSpy).not.toHaveBeenCalled();
      expect(getMemoryBlob(locator)).toBeTruthy();

      const after = await AnswerFileModel.findById(fileId);
      expect(after!.storageLocator).toBe(locator);
      expect(after!.storageProvider).toBe('VERCEL_BLOB');
    });
  });

  describe('Download after deletion', () => {
    it('denies Student, assigned Evaluator, and Admin download of a DELETED AnswerFile', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      await uploadQuestionPaper(app, catalog.adminToken, catalog.pdf.id);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);
      const { studentToken, submissionId } = await submitPdfAttempt(app, catalog);

      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluatorId = await userIdFor('evaluator@example.com');
      const evaluation = await EvaluationModel.findOne({ submissionId });
      expect(evaluation).toBeTruthy();

      const assigned = await request(app)
        .post(`/admin/evaluations/${evaluation!._id.toString()}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      expect(assigned.status).toBe(200);

      const beforeEvaluator = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(evaluatorToken));
      expect(beforeEvaluator.status).toBe(200);

      const deleted = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(deleted.status).toBe(200);

      const studentDownload = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(studentToken));
      expectDownloadDenied(studentDownload);

      const evaluatorDownload = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(evaluatorToken));
      expectDownloadDenied(evaluatorDownload);

      const adminDownload = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(catalog.adminToken));
      expectDownloadDenied(adminDownload);
    });
  });

  describe('Isolation', () => {
    it('deleting one AnswerFile does not modify another AnswerFile, the Test Series, QuestionFiles, or SubmissionFiles', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId: questionFileId } = await uploadQuestionPaper(
        app,
        catalog.adminToken,
        catalog.pdf.id,
      );
      const { fileId: keepId } = await uploadAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('keep'),
      );
      const { fileId: deleteId } = await uploadAnswerFile(
        app,
        catalog.adminToken,
        catalog.pdf.id,
        pdfBytes('remove'),
      );
      const submitted = await submitPdfAttempt(app, catalog);

      const beforeSeries = await TestSeriesModel.findById(catalog.pdf.id);
      const beforeQuestion = await QuestionFileModel.findById(questionFileId);
      const beforeKeep = await AnswerFileModel.findById(keepId);
      const beforeSubmission = await SubmissionFileModel.findById(submitted.submissionFileId);

      const res = await request(app)
        .delete(`/admin/answer-files/${deleteId}`)
        .set(bearer(catalog.adminToken));
      expect(res.status).toBe(200);

      const afterSeries = await TestSeriesModel.findById(catalog.pdf.id);
      const afterQuestion = await QuestionFileModel.findById(questionFileId);
      const afterKeep = await AnswerFileModel.findById(keepId);
      const afterDeleted = await AnswerFileModel.findById(deleteId);
      const afterSubmission = await SubmissionFileModel.findById(submitted.submissionFileId);

      expect(afterKeep!.status).toBe('ACTIVE');
      expect(afterKeep!.storageLocator).toBe(beforeKeep!.storageLocator);
      expect(afterKeep!.originalName).toBe(beforeKeep!.originalName);
      expect(afterKeep!.sizeBytes).toBe(beforeKeep!.sizeBytes);
      expect(afterDeleted!.status).toBe('DELETED');
      expect(afterSeries!.toObject()).toMatchObject({
        title: beforeSeries!.title,
        status: beforeSeries!.status,
        type: beforeSeries!.type,
      });
      expect(afterQuestion!.status).toBe(beforeQuestion!.status);
      expect(afterQuestion!.storageLocator).toBe(beforeQuestion!.storageLocator);
      expect(afterSubmission!.status).toBe(beforeSubmission!.status);
      expect(afterSubmission!.storageLocator).toBe(beforeSubmission!.storageLocator);
    });
  });

  describe('Validation / security', () => {
    it('rejects an invalid ObjectId', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);

      const res = await request(app)
        .delete('/admin/answer-files/not-an-id')
        .set(bearer(catalog.adminToken));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('rejects unknown body fields, MongoDB operators, client-supplied status, and storage metadata', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const unknown = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken))
        .send({ ownerId: 'client' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const operators = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken))
        .send({ $set: { status: 'DELETED' } });
      expect(operators.status).toBe(400);
      expect(operators.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const status = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken))
        .send({ status: 'ACTIVE' });
      expect(status.status).toBe(400);
      expect(status.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const storage = await request(app)
        .delete(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken))
        .send({ storageLocator: 'evil', storageProvider: 'S3', testSeriesId: catalog.pdf.id });
      expect(storage.status).toBe(400);
      expect(storage.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const stillActive = await AnswerFileModel.findById(fileId);
      expect(stillActive!.status).toBe('ACTIVE');
    });

    it('does not expose generic PATCH or alternate delete paths', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await uploadAnswerFile(app, catalog.adminToken, catalog.pdf.id);

      const patch = await request(app)
        .patch(`/admin/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken))
        .send({ status: 'DELETED' });
      expect(patch.status).toBe(404);

      const filesDelete = await request(app)
        .delete(`/files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(filesDelete.status).toBe(404);

      const adminFilesDelete = await request(app)
        .delete(`/admin/files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(adminFilesDelete.status).toBe(404);

      const nested = await request(app)
        .delete(`/admin/test-series/${catalog.pdf.id}/answer-files/${fileId}`)
        .set(bearer(catalog.adminToken));
      expect(nested.status).toBe(404);

      const stillActive = await AnswerFileModel.findById(fileId);
      expect(stillActive!.status).toBe('ACTIVE');
    });
  });
});
