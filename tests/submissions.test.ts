import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
import { AuditLogModel } from '../src/database/models/audit-log.model';
import { CategoryModel } from '../src/database/models/category.model';
import {
  PAID_ENTITLEMENT_VALIDITY_DAYS,
  PDF_SUBMISSION_MAX_SIZE_BYTES,
} from '../src/database/models/conventions';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { EvaluationRevisionModel } from '../src/database/models/evaluation-revision.model';
import { ModuleModel } from '../src/database/models/module.model';
import { QuestionModel } from '../src/database/models/question.model';
import { ResultModel } from '../src/database/models/result.model';
import { SubmissionFileModel } from '../src/database/models/submission-file.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
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
const mcqScoring = { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 };

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

describe('Phase 9 Submission and PDF files', () => {
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

  async function studentIdFor(email: string): Promise<string> {
    const user = await userRepository.findByEmail(email);
    expect(user).toBeTruthy();
    return user!._id.toString();
  }

  async function startPdfAttempt(app: App, studentToken: string, testSeriesId: string) {
    const started = await request(app)
      .post('/attempts')
      .set(bearer(studentToken))
      .send({ testSeriesId });
    expect(started.status).toBe(201);
    return started.body.data as {
      id: string;
      examEndsAt: string;
      uploadEndsAt: string | null;
      status: string;
    };
  }

  async function enterUploadPending(app: App, studentToken: string, attemptId: string) {
    await AttemptModel.findByIdAndUpdate(attemptId, {
      examEndsAt: new Date(Date.now() - 1000),
    });

    const retrieved = await request(app).get(`/me/attempts/${attemptId}`).set(bearer(studentToken));
    expect(retrieved.status).toBe(200);
    expect(retrieved.body.data.status).toBe('UPLOAD_PENDING');
    return retrieved.body.data as { id: string; status: string; uploadEndsAt: string | null };
  }

  async function authorizeAndStorePdf(
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

    return { fileId, storageLocator: stored!.storageLocator, upload: authorized.body.data };
  }

  describe('MCQ submission', () => {
    it('creates an immutable Submission with selectedOptionId and no Result', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });

      await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });

      const submitted = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');

      const submission = await SubmissionModel.findById(submitted.body.data.submissionId);
      expect(submission).toBeTruthy();
      expect(submission!.type).toBe('MCQ');
      expect(submission!.answers?.[0]?.selectedOptionId).toBe('B');
      expect(JSON.stringify(submission!.toObject())).not.toContain('correctOptionId');
      expect(submission!.toObject()).not.toHaveProperty('selectedOptionIds');

      const repeat = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(repeat.status).toBe(200);
      expect(repeat.body.data.submissionId).toBe(submitted.body.data.submissionId);
      expect(await SubmissionModel.countDocuments({})).toBe(1);

      const mutate = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(mutate.status).toBe(409);

      expect(await EvaluationModel.countDocuments({})).toBe(1);
      expect(await ResultModel.countDocuments({})).toBe(1);
    });

    it('prevents concurrent double submit from creating two Submissions', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });

      const [first, second] = await Promise.all([
        request(app).post(`/attempts/${started.body.data.id}/submit`).set(bearer(studentToken)),
        request(app).post(`/attempts/${started.body.data.id}/submit`).set(bearer(studentToken)),
      ]);

      expect([first.status, second.status].every((status) => status === 200)).toBe(true);
      expect(first.body.data.submissionId).toBe(second.body.data.submissionId);
      expect(await SubmissionModel.countDocuments({})).toBe(1);
    });
  });

  describe('EDITOR submission', () => {
    it('submits the persisted Rich Text document and rejects unsupported fields', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.editor.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });

      const doc = { type: 'doc', content: [{ type: 'paragraph', text: 'final answer' }] };
      await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: doc });

      const unsupported = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({ version: 2, editorDocument: { type: 'doc', code: 'print(1)' } });
      expect(unsupported.status).toBe(400);

      const submitted = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);

      const submission = await SubmissionModel.findById(submitted.body.data.submissionId);
      expect(submission!.type).toBe('EDITOR');
      expect(submission!.editorDocument).toEqual(doc);

      const repeat = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(repeat.body.data.submissionId).toBe(submitted.body.data.submissionId);
      expect(await SubmissionModel.countDocuments({})).toBe(1);
      expect(await EvaluationModel.countDocuments({})).toBe(1);
    });
  });

  describe('PDF upload and finalization', () => {
    it('transitions to UPLOAD_PENDING, stores PDF in Blob, and finalizes one SubmissionFile', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await startPdfAttempt(app, studentToken, catalog.pdf.id);
      const pending = await enterUploadPending(app, studentToken, started.id);
      expect(pending.uploadEndsAt).toBe(started.uploadEndsAt);
      expect(new Date(started.uploadEndsAt!).getTime()).toBe(
        new Date(started.examEndsAt).getTime() + 5 * 60 * 1000,
      );

      const body = pdfBytes('student-answer');
      const { fileId, storageLocator, upload } = await authorizeAndStorePdf(
        app,
        studentToken,
        started.id,
        body,
      );

      expect(upload.uploadUrl).toContain('https://blob.test/upload/');
      expect(JSON.stringify(upload)).not.toContain('AWS_ACCESS_KEY_ID');
      expect(JSON.stringify(upload)).not.toContain('secret');
      expect(upload.file.storageLocator).toBeUndefined();

      const storedObject = getMemoryBlob(storageLocator);
      expect(storedObject?.body.equals(body)).toBe(true);

      const fileDoc = await SubmissionFileModel.findById(fileId);
      expect(fileDoc!.status).toBe('ACTIVE');
      expect(fileDoc!.sizeBytes).toBe(body.length);
      expect(fileDoc!.toObject()).not.toHaveProperty('uploadUrl');
      expect(fileDoc!.mimeType).toBe('application/pdf');

      const submitted = await request(app)
        .post(`/attempts/${started.id}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');

      const submission = await SubmissionModel.findById(submitted.body.data.submissionId);
      expect(submission!.type).toBe('PDF');
      expect(submission!.answerSheetFile?.toString()).toBe(fileId);
      expect(submission!.toObject()).not.toHaveProperty('content');

      const linked = await SubmissionFileModel.findById(fileId);
      expect(linked!.submissionId?.toString()).toBe(submission!._id.toString());
      expect(await SubmissionModel.countDocuments({})).toBe(1);
      expect(await EvaluationModel.countDocuments({})).toBe(1);
      expect(await ResultModel.countDocuments({})).toBe(0);

      const after = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'other.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
        });
      expect(after.status).toBe(409);
      expect(after.body.error.code).toBe(ErrorCodes.ATTEMPT_ALREADY_SUBMITTED);
    });

    it('rejects non-PDF content, oversized files, and incomplete finalization', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await startPdfAttempt(app, studentToken, catalog.pdf.id);
      await enterUploadPending(app, studentToken, started.id);

      const notPdf = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'answer.bin',
          contentType: 'application/octet-stream',
          sizeBytes: 100,
        });
      expect(notPdf.status).toBe(400);
      expect(notPdf.body.error.code).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED);

      const tooLarge = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'answer.pdf',
          contentType: 'application/pdf',
          sizeBytes: PDF_SUBMISSION_MAX_SIZE_BYTES + 1,
        });
      expect(tooLarge.status).toBe(400);
      expect(tooLarge.body.error.code).toBe(ErrorCodes.FILE_TOO_LARGE);

      const authorized = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'answer.pdf',
          contentType: 'application/pdf',
          sizeBytes: 50,
        });
      expect(authorized.status).toBe(200);

      const file = await SubmissionFileModel.findById(authorized.body.data.fileId);
      putMemoryBlob(file!.storageLocator, Buffer.from('not-a-pdf'), 'application/pdf');
      const badMagic = await request(app)
        .post(`/files/${authorized.body.data.fileId}/complete`)
        .set(bearer(studentToken))
        .send({});
      expect(badMagic.status).toBe(400);
      expect(badMagic.body.error.code).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED);

      const oversizedObject = Buffer.concat([
        Buffer.from('%PDF'),
        Buffer.alloc(PDF_SUBMISSION_MAX_SIZE_BYTES, 0x20),
      ]);
      const authorizedLarge = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'answer.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
        });
      const largeFile = await SubmissionFileModel.findById(authorizedLarge.body.data.fileId);
      putMemoryBlob(largeFile!.storageLocator, oversizedObject, 'application/pdf');
      const largeComplete = await request(app)
        .post(`/files/${authorizedLarge.body.data.fileId}/complete`)
        .set(bearer(studentToken))
        .send({});
      expect(largeComplete.status).toBe(400);
      expect(largeComplete.body.error.code).toBe(ErrorCodes.FILE_TOO_LARGE);

      const missingUpload = await request(app)
        .post(`/attempts/${started.id}/submit`)
        .set(bearer(studentToken));
      expect(missingUpload.status).toBe(409);
      expect(missingUpload.body.error.code).toBe(ErrorCodes.FILE_UPLOAD_INCOMPLETE);
      expect(await SubmissionModel.countDocuments({})).toBe(0);
    });

    it('allows PDF upload and submit during IN_PROGRESS before examEndsAt', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await startPdfAttempt(app, studentToken, catalog.pdf.id);
      expect(started.status).toBe('IN_PROGRESS');

      const missingFile = await request(app)
        .post(`/attempts/${started.id}/submit`)
        .set(bearer(studentToken));
      expect(missingFile.status).toBe(409);
      expect(missingFile.body.error.code).toBe(ErrorCodes.FILE_UPLOAD_INCOMPLETE);

      const { fileId } = await authorizeAndStorePdf(app, studentToken, started.id);

      const retrieved = await request(app)
        .get(`/me/attempts/${started.id}`)
        .set(bearer(studentToken));
      expect(retrieved.status).toBe(200);
      expect(retrieved.body.data.status).toBe('IN_PROGRESS');
      expect(retrieved.body.data.currentSubmissionFileId).toBe(fileId);

      const submitted = await request(app)
        .post(`/attempts/${started.id}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');

      const submission = await SubmissionModel.findById(submitted.body.data.submissionId);
      expect(submission!.type).toBe('PDF');
      expect(submission!.answerSheetFile?.toString()).toBe(fileId);
      expect(await EvaluationModel.countDocuments({})).toBe(1);

      const afterSubmit = await request(app)
        .get(`/me/attempts/${started.id}`)
        .set(bearer(studentToken));
      expect(afterSubmit.status).toBe(200);
      expect(afterSubmit.body.data.currentSubmissionFileId).toBeNull();
      expect(afterSubmit.body.data.submittedFileId).toBe(fileId);
    });
  });

  describe('ownership, timing, and security', () => {
    it('prevents Student A from submitting, uploading, or completing Student B resources', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const otherToken = await login(app, 'student2@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await startPdfAttempt(app, studentToken, catalog.pdf.id);
      await enterUploadPending(app, studentToken, started.id);
      const { fileId } = await authorizeAndStorePdf(app, studentToken, started.id);

      const otherUpload = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(otherToken))
        .send({
          originalName: 'answer.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
        });
      expect(otherUpload.status).toBe(404);

      const otherComplete = await request(app)
        .post(`/files/${fileId}/complete`)
        .set(bearer(otherToken))
        .send({});
      expect(otherComplete.status).toBe(404);

      const otherSubmit = await request(app)
        .post(`/attempts/${started.id}/submit`)
        .set(bearer(otherToken));
      expect(otherSubmit.status).toBe(404);

      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluatorUpload = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(evaluatorToken))
        .send({
          originalName: 'answer.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
        });
      expect(evaluatorUpload.status).toBe(403);

      const unauth = await request(app).post(`/attempts/${started.id}/upload-url`).send({
        originalName: 'answer.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      });
      expect(unauth.status).toBe(401);
    });

    it('rejects client-controlled timing and arbitrary Blob locators, and downloads without exposing storage metadata', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await startPdfAttempt(app, studentToken, catalog.pdf.id);
      await enterUploadPending(app, studentToken, started.id);

      const timed = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'answer.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
          uploadEndsAt: '2099-01-01T00:00:00.000Z',
          examEndsAt: '2099-01-01T00:00:00.000Z',
        });
      expect(timed.status).toBe(400);

      const injectedKey = await request(app)
        .post(`/attempts/${started.id}/upload-url`)
        .set(bearer(studentToken))
        .send({
          originalName: 'answer.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
          storageLocator: 'other-student.pdf',
        });
      expect(injectedKey.status).toBe(400);

      const { fileId } = await authorizeAndStorePdf(app, studentToken, started.id);
      const completeInject = await request(app)
        .post(`/files/${fileId}/complete`)
        .set(bearer(studentToken))
        .send({ storageLocator: 'injected.pdf', storageProvider: 'VERCEL_BLOB' });
      expect(completeInject.status).toBe(400);

      const download = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(studentToken));
      expect(download.status).toBe(200);
      expect(download.body.data).toEqual({ downloadUrl: download.body.data.downloadUrl });
      expect(download.body.data).not.toHaveProperty('storageLocator');

      await AttemptModel.findByIdAndUpdate(started.id, {
        uploadEndsAt: new Date(Date.now() - 1000),
      });

      const expired = await request(app)
        .post(`/attempts/${started.id}/submit`)
        .set(bearer(studentToken));
      expect(expired.status).toBe(409);
      expect(expired.body.error.code).toBe(ErrorCodes.FILE_UPLOAD_EXPIRED);

      const attempt = await AttemptModel.findById(started.id);
      expect(attempt!.status).toBe('EXPIRED');
    });

    it('makes PDF finalization idempotent across duplicate complete and submit', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.pdf.id);

      const started = await startPdfAttempt(app, studentToken, catalog.pdf.id);
      await enterUploadPending(app, studentToken, started.id);
      const { fileId } = await authorizeAndStorePdf(app, studentToken, started.id);

      const completeAgain = await request(app)
        .post(`/files/${fileId}/complete`)
        .set(bearer(studentToken))
        .send({});
      expect(completeAgain.status).toBe(200);
      expect(completeAgain.body.data.id).toBe(fileId);

      const [first, second] = await Promise.all([
        request(app).post(`/attempts/${started.id}/submit`).set(bearer(studentToken)),
        request(app).post(`/attempts/${started.id}/submit`).set(bearer(studentToken)),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.data.submissionId).toBe(second.body.data.submissionId);
      expect(await SubmissionModel.countDocuments({})).toBe(1);
      expect(await SubmissionFileModel.countDocuments({ status: 'ACTIVE' })).toBe(1);
    });
  });
});
