import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
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
  getLastPresignedDownload,
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

describe('Phase 13 Authorized submission file download', () => {
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
    await QuestionFileModel.createIndexes();
    await AnswerFileModel.createIndexes();
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
            { id: 'C', text: '5' },
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

  async function uploadActivePdf(
    app: App,
    studentToken: string,
    attemptId: string,
    body = pdfBytes(),
  ) {
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
    expect(stored).toBeTruthy();
    putMemoryBlob(stored!.storageLocator, body, 'application/pdf');

    const completed = await request(app)
      .post(`/files/${fileId}/complete`)
      .set(bearer(studentToken))
      .send({});
    expect(completed.status).toBe(200);
    expect(completed.body.data.status).toBe('ACTIVE');

    return { fileId, stored: stored! };
  }

  async function startPdfUploadPending(app: App, catalog: Awaited<ReturnType<typeof seedCatalog>>) {
    const studentToken = await login(app, 'student@example.com');
    const studentId = await userIdFor('student@example.com');
    await grantPaidEntitlement(studentId, catalog.pdf.id);

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
    expect(pending.status).toBe(200);
    expect(pending.body.data.status).toBe('UPLOAD_PENDING');

    return {
      studentToken,
      studentId,
      attemptId: started.body.data.id as string,
      pending: pending.body.data as {
        id: string;
        status: string;
        currentSubmissionFileId: string | null;
      },
    };
  }

  async function submitPdfAttempt(app: App, catalog: Awaited<ReturnType<typeof seedCatalog>>) {
    const session = await startPdfUploadPending(app, catalog);
    const uploaded = await uploadActivePdf(app, session.studentToken, session.attemptId);
    const submitted = await request(app)
      .post(`/attempts/${session.attemptId}/submit`)
      .set(bearer(session.studentToken));
    expect(submitted.status).toBe(200);
    return { ...session, ...uploaded, submitted };
  }

  describe('Student authorization', () => {
    it('allows a student to download their own ACTIVE submission file', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { studentToken, fileId } = await submitPdfAttempt(app, catalog);

      const response = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(studentToken));

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);
      expect(response.body.data).not.toHaveProperty('storageLocator');
      expect(Object.keys(response.body.data)).toEqual(['downloadUrl']);
    });

    it('denies a student downloading another student submission file', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await submitPdfAttempt(app, catalog);
      const otherToken = await login(app, 'student2@example.com');

      const response = await request(app).get(`/files/${fileId}/download`).set(bearer(otherToken));

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);
    });

    it('rejects PENDING, REPLACED, and DELETED submission files', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const session = await startPdfUploadPending(app, catalog);

      const pendingAuth = await request(app)
        .post(`/attempts/${session.attemptId}/upload-url`)
        .set(bearer(session.studentToken))
        .send({
          originalName: 'pending.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
        });
      expect(pendingAuth.status).toBe(200);
      const pendingId = pendingAuth.body.data.fileId as string;

      const pendingDownload = await request(app)
        .get(`/files/${pendingId}/download`)
        .set(bearer(session.studentToken));
      expect(pendingDownload.status).toBe(403);
      expect(pendingDownload.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);

      const first = await uploadActivePdf(
        app,
        session.studentToken,
        session.attemptId,
        pdfBytes('a'),
      );
      const second = await uploadActivePdf(
        app,
        session.studentToken,
        session.attemptId,
        pdfBytes('b'),
      );

      const replaced = await SubmissionFileModel.findById(first.fileId);
      expect(replaced!.status).toBe('REPLACED');

      const replacedDownload = await request(app)
        .get(`/files/${first.fileId}/download`)
        .set(bearer(session.studentToken));
      expect(replacedDownload.status).toBe(403);
      expect(replacedDownload.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);

      await SubmissionFileModel.findByIdAndUpdate(second.fileId, { $set: { status: 'DELETED' } });
      const deletedDownload = await request(app)
        .get(`/files/${second.fileId}/download`)
        .set(bearer(session.studentToken));
      expect(deletedDownload.status).toBe(403);
      expect(deletedDownload.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);
    });

    it('allows only owned question papers and always denies answer files for students', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const adminId = await userIdFor('admin@example.com');
      const studentId = await userIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const questionFile = await QuestionFileModel.create({
        testSeriesId: catalog.pdf.id,
        status: 'ACTIVE',
        storageProvider: 'VERCEL_BLOB',
        storageLocator: 'question-secret.pdf',
        originalName: 'paper.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12,
        uploadedBy: adminId,
      });
      const answerFile = await AnswerFileModel.create({
        testSeriesId: catalog.pdf.id,
        status: 'ACTIVE',
        storageProvider: 'VERCEL_BLOB',
        storageLocator: 'answer-secret.pdf',
        originalName: 'key.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12,
        uploadedBy: adminId,
      });
      putMemoryBlob('question-secret.pdf', pdfBytes('question'), 'application/pdf');
      putMemoryBlob('answer-secret.pdf', pdfBytes('answer'), 'application/pdf');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);
      expect(started.body.data.questionPaperFileId).toBe(questionFile._id.toString());

      const questionDownload = await request(app)
        .get(`/files/${questionFile._id.toString()}/download`)
        .set(bearer(studentToken));
      expect(questionDownload.status).toBe(200);
      expect(questionDownload.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);

      const answerDownload = await request(app)
        .get(`/files/${answerFile._id.toString()}/download`)
        .set(bearer(studentToken));
      expect(answerDownload.status).toBe(403);
      expect(answerDownload.body.error.code).toBe(ErrorCodes.FILE_NOT_ACCESSIBLE);
    });

    it('returns a safe error for an unknown file id', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const unknownId = new Types.ObjectId().toString();

      const response = await request(app)
        .get(`/files/${unknownId}/download`)
        .set(bearer(studentToken));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(ErrorCodes.FILE_NOT_FOUND);
      expect(JSON.stringify(response.body)).not.toContain('BLOB_READ_WRITE_TOKEN');
      expect(JSON.stringify(response.body)).not.toContain('storageLocator');
    });
  });

  describe('Evaluator authorization', () => {
    it('allows only the assigned evaluator to download the submission file', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      await assignCategory('evaluator2@example.com', catalog.categoryId);
      const { fileId, submitted } = await submitPdfAttempt(app, catalog);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluator2Token = await login(app, 'evaluator2@example.com');
      const evaluatorId = await userIdFor('evaluator@example.com');

      const evaluation = await EvaluationModel.findOne({
        submissionId: submitted.body.data.submissionId,
      });
      expect(evaluation).toBeTruthy();

      const unassigned = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(evaluatorToken));
      expect(unassigned.status).toBe(403);
      expect(unassigned.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_ASSIGNED);

      const assigned = await request(app)
        .post(`/admin/evaluations/${evaluation!._id.toString()}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      expect(assigned.status).toBe(200);

      const allowed = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(evaluatorToken));
      expect(allowed.status).toBe(200);
      expect(allowed.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);

      const denied = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(evaluator2Token));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_ASSIGNED);
    });

    it('does not grant access from category membership alone', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const { fileId } = await submitPdfAttempt(app, catalog);
      const evaluatorToken = await login(app, 'evaluator@example.com');

      const response = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(evaluatorToken));

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_ASSIGNED);
    });

    it('does not allow inactive category assignment to bypass authorization', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const assignment = await assignCategory('evaluator@example.com', catalog.categoryId, true);
      const { fileId, submitted } = await submitPdfAttempt(app, catalog);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluatorId = await userIdFor('evaluator@example.com');

      const evaluation = await EvaluationModel.findOne({
        submissionId: submitted.body.data.submissionId,
      });
      const assigned = await request(app)
        .post(`/admin/evaluations/${evaluation!._id.toString()}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      expect(assigned.status).toBe(200);

      await evaluatorCategoryAssignmentRepository.updateById(assignment._id, {
        $set: { isActive: false },
      });

      const response = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(evaluatorToken));

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_AUTHORIZED);
    });
  });

  describe('Admin authorization', () => {
    it('allows an admin to download an ACTIVE submission file', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await submitPdfAttempt(app, catalog);

      const response = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(catalog.adminToken));

      expect(response.status).toBe(200);
      expect(response.body.data.downloadUrl).toMatch(/^https:\/\/blob\.test\/download\//);
      expect(response.body.data).not.toHaveProperty('storageLocator');
    });
  });

  describe('Blob and Attempt DTO', () => {
    it('generates a short-lived configured Blob download URL without persisting URL or exposing storage metadata', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { studentToken, fileId, stored } = await submitPdfAttempt(app, catalog);

      const response = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(studentToken));

      expect(response.status).toBe(200);
      expect(getLastPresignedDownload()).toEqual({
        locator: stored.storageLocator,
        expiresInSeconds: 45,
      });
      expect(response.body.data.downloadUrl).toContain('expires=45');
      expect(Object.keys(response.body.data)).toEqual(['downloadUrl']);

      const persisted = await SubmissionFileModel.findById(fileId).lean();
      expect(persisted).toBeTruthy();
      expect(JSON.stringify(persisted)).not.toContain(response.body.data.downloadUrl);
      expect(persisted).not.toHaveProperty('downloadUrl');
      expect(persisted).not.toHaveProperty('presignedUrl');
    });

    it('exposes currentSubmissionFileId on PDF UPLOAD_PENDING without Blob metadata', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const session = await startPdfUploadPending(app, catalog);
      expect(session.pending.currentSubmissionFileId).toBeNull();

      const uploaded = await uploadActivePdf(app, session.studentToken, session.attemptId);
      const retrieved = await request(app)
        .get(`/me/attempts/${session.attemptId}`)
        .set(bearer(session.studentToken));

      expect(retrieved.status).toBe(200);
      expect(retrieved.body.data.status).toBe('UPLOAD_PENDING');
      expect(retrieved.body.data.currentSubmissionFileId).toBe(uploaded.fileId);
      expect(retrieved.body.data).not.toHaveProperty('storageLocator');
      expect(retrieved.body.data).not.toHaveProperty('downloadUrl');
      expect(retrieved.body.data).not.toHaveProperty('presignedUrl');

      const studentToken = await login(app, 'student@example.com');
      const mcqStarted = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(mcqStarted.status).toBe(201);
      expect(mcqStarted.body.data.currentSubmissionFileId).toBeNull();
    });
  });

  describe('Security boundaries', () => {
    it('ignores client-supplied ownership and storage fields and rejects unknown query fields', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { fileId } = await submitPdfAttempt(app, catalog);
      const otherToken = await login(app, 'student2@example.com');
      const otherStudentId = await userIdFor('student2@example.com');

      const bypass = await request(app)
        .get(`/files/${fileId}/download`)
        .query({
          studentId: otherStudentId,
          storageProvider: 'VERCEL_BLOB',
          storageLocator: 'evil.pdf',
        })
        .set(bearer(otherToken));

      expect(bypass.status).toBe(400);
      expect(bypass.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const operator = await request(app)
        .get(`/files/${fileId}/download`)
        .query({ $gt: '' })
        .set(bearer(otherToken));
      expect(operator.status).toBe(400);
      expect(operator.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const unauthenticated = await request(app).get(`/files/${fileId}/download`);
      expect(unauthenticated.status).toBe(401);
    });
  });
});
