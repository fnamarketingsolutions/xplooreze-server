import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
import { AuditLogModel } from '../src/database/models/audit-log.model';
import { CategoryModel } from '../src/database/models/category.model';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { EvaluationRevisionModel } from '../src/database/models/evaluation-revision.model';
import { EvaluatorCategoryAssignmentModel } from '../src/database/models/evaluator-category-assignment.model';
import { ModuleModel } from '../src/database/models/module.model';
import { QuestionModel } from '../src/database/models/question.model';
import { ResultModel } from '../src/database/models/result.model';
import { SubmissionFileModel } from '../src/database/models/submission-file.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../src/database/models/conventions';
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

describe('Phase 10 Evaluation Engine', () => {
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

    const otherCategory = await request(app)
      .post('/admin/categories')
      .set(bearer(adminToken))
      .send({ name: 'Physics' });
    expect(otherCategory.status).toBe(201);

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

    const mcqQuestions = [];
    for (const [index, correct] of ['B', 'B', 'B'].entries()) {
      const created = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: mcq.body.data.id,
          position: index + 1,
          questionText: `Question ${index + 1}`,
          content: mcqContent(correct),
        });
      expect(created.status).toBe(201);
      mcqQuestions.push(created.body.data as { id: string });
    }

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
      categoryId: category.body.data.id as string,
      otherCategoryId: otherCategory.body.data.id as string,
      mcq: mcq.body.data as { id: string },
      editor: editor.body.data as { id: string },
      pdf: pdf.body.data as { id: string },
      mcqQuestions,
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

  async function assignCategory(evaluatorEmail: string, categoryId: string, isActive = true) {
    const evaluatorId = await studentIdFor(evaluatorEmail);
    return evaluatorCategoryAssignmentRepository.create({
      evaluatorId,
      categoryId,
      isActive,
    });
  }

  async function submitMcq(
    app: App,
    catalog: Awaited<ReturnType<typeof seedCatalog>>,
    answers: Array<{ questionId: string; selectedOptionId: string | null }>,
  ) {
    const studentToken = await login(app, 'student@example.com');
    const started = await request(app)
      .post('/attempts')
      .set(bearer(studentToken))
      .send({ testSeriesId: catalog.mcq.id });
    expect(started.status).toBe(201);

    await request(app)
      .patch(`/attempts/${started.body.data.id}/answers`)
      .set(bearer(studentToken))
      .send({ version: 1, answers });

    const submitted = await request(app)
      .post(`/attempts/${started.body.data.id}/submit`)
      .set(bearer(studentToken));
    expect(submitted.status).toBe(200);
    return { studentToken, attemptId: started.body.data.id as string, submitted };
  }

  async function submitEditor(
    app: App,
    catalog: Awaited<ReturnType<typeof seedCatalog>>,
    doc: unknown,
  ) {
    const studentToken = await login(app, 'student@example.com');
    const studentId = await studentIdFor('student@example.com');
    await grantPaidEntitlement(studentId, catalog.editor.id);

    const started = await request(app)
      .post('/attempts')
      .set(bearer(studentToken))
      .send({ testSeriesId: catalog.editor.id });
    expect(started.status).toBe(201);

    await request(app)
      .patch(`/attempts/${started.body.data.id}/answers`)
      .set(bearer(studentToken))
      .send({ version: 1, editorDocument: doc });

    const submitted = await request(app)
      .post(`/attempts/${started.body.data.id}/submit`)
      .set(bearer(studentToken));
    expect(submitted.status).toBe(200);
    return { studentToken, submitted };
  }

  async function submitPdf(app: App, catalog: Awaited<ReturnType<typeof seedCatalog>>) {
    const studentToken = await login(app, 'student@example.com');
    const studentId = await studentIdFor('student@example.com');
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
    expect(authorized.status).toBe(200);
    const fileId = authorized.body.data.fileId as string;
    const stored = await SubmissionFileModel.findById(fileId);
    putMemoryBlob(stored!.storageLocator, body, 'application/pdf');
    await request(app).post(`/files/${fileId}/complete`).set(bearer(studentToken)).send({});

    const submitted = await request(app)
      .post(`/attempts/${started.body.data.id}/submit`)
      .set(bearer(studentToken));
    expect(submitted.status).toBe(200);
    return { studentToken, submitted, fileId };
  }

  async function adminEvaluationId(app: App, adminToken: string, submissionId: string) {
    const listed = await request(app).get('/admin/evaluations').set(bearer(adminToken));
    expect(listed.status).toBe(200);
    const found = (listed.body.data as Array<{ id: string; submissionId: string }>).find(
      (item) => item.submissionId === submissionId,
    );
    expect(found).toBeTruthy();
    return found!.id;
  }

  describe('MCQ automatic evaluation', () => {
    it('scores the Attempt snapshot, normalizes to 2 decimals, and is idempotent', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { submitted } = await submitMcq(app, catalog, [
        { questionId: catalog.mcqQuestions[0]!.id, selectedOptionId: 'B' },
        { questionId: catalog.mcqQuestions[1]!.id, selectedOptionId: 'A' },
      ]);

      expect(await EvaluationModel.countDocuments({})).toBe(1);
      expect(await EvaluationRevisionModel.countDocuments({})).toBe(1);
      expect(await ResultModel.countDocuments({})).toBe(1);

      const evaluation = await EvaluationModel.findOne({
        submissionId: submitted.body.data.submissionId,
      });
      expect(evaluation!.mode).toBe('AUTOMATIC');
      expect(evaluation!.status).toBe('FINALIZED');
      expect(evaluation!.evaluatorId).toBeNull();
      expect(evaluation!.score).toBe(3);
      expect(evaluation!.maxScore).toBe(12);

      const revision = await EvaluationRevisionModel.findById(evaluation!.currentRevisionId);
      expect(revision!.revisionNumber).toBe(1);
      expect(revision!.status).toBe('FINALIZED');
      expect(revision!.metrics).toMatchObject({
        correctCount: 1,
        incorrectCount: 1,
        unansweredCount: 1,
      });
      expect(revision!.scoringSnapshot).toMatchObject(mcqScoring);

      const repeat = await request(app)
        .post(`/attempts/${submitted.body.data.attemptId}/submit`)
        .set(bearer(await login(app, 'student@example.com')));
      expect(repeat.status).toBe(200);
      expect(await EvaluationModel.countDocuments({})).toBe(1);
      expect(await EvaluationRevisionModel.countDocuments({})).toBe(1);

      const [first, second] = await Promise.all([
        request(app)
          .post(`/attempts/${submitted.body.data.attemptId}/submit`)
          .set(bearer(await login(app, 'student@example.com'))),
        request(app)
          .post(`/attempts/${submitted.body.data.attemptId}/submit`)
          .set(bearer(await login(app, 'student@example.com'))),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await EvaluationModel.countDocuments({})).toBe(1);

      await request(app)
        .patch(`/admin/test-series/${catalog.mcq.id}`)
        .set(bearer(catalog.adminToken))
        .send({ scoring: { correctMarks: 5, incorrectMarks: -2, unansweredMarks: 0 } });

      const unchanged = await EvaluationModel.findById(evaluation!._id);
      expect(unchanged!.score).toBe(3);
      expect(unchanged!.maxScore).toBe(12);

      const assign = await request(app)
        .post(`/admin/evaluations/${evaluation!._id.toString()}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await studentIdFor('evaluator@example.com') });
      expect(assign.status).toBe(409);

      const payload = JSON.stringify(evaluation!.toObject());
      expect(payload).not.toContain('correctOptionId');
      expect(await ResultModel.countDocuments({})).toBe(1);
    });
  });

  describe('PDF and EDITOR manual evaluation', () => {
    it('runs the PDF evaluator workflow through Admin finalization and re-evaluation', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluator2Token = await login(app, 'evaluator2@example.com');
      const evaluatorId = await studentIdFor('evaluator@example.com');
      const { submitted, fileId } = await submitPdf(app, catalog);

      const evaluation = await EvaluationModel.findOne({
        submissionId: submitted.body.data.submissionId,
      });
      expect(evaluation!.mode).toBe('MANUAL');
      expect(evaluation!.status).toBe('UNASSIGNED');
      const evaluationId = evaluation!._id.toString();

      const adminListed = await request(app)
        .get('/admin/evaluations')
        .set(bearer(catalog.adminToken));
      expect(adminListed.status).toBe(200);
      expect(adminListed.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: evaluationId,
            testSeries: expect.objectContaining({
              categoryId: catalog.categoryId,
              categoryName: 'Mathematics',
            }),
          }),
        ]),
      );

      const adminDetail = await request(app)
        .get(`/admin/evaluations/${evaluationId}`)
        .set(bearer(catalog.adminToken));
      expect(adminDetail.status).toBe(200);
      expect(adminDetail.body.data.testSeries).toMatchObject({
        categoryId: catalog.categoryId,
        categoryName: 'Mathematics',
      });
      expect(adminDetail.body.data.student).toMatchObject({
        email: 'student@example.com',
        displayName: 'Stu Dent',
      });
      expect(adminDetail.body.data.attempt).toMatchObject({ attemptNumber: 1 });
      expect(adminDetail.body.data.evaluator).toBeNull();

      const unauthorized = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await studentIdFor('evaluator2@example.com') });
      expect(unauthorized.status).toBe(403);
      expect(unauthorized.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_AUTHORIZED);

      const assigned = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      expect(assigned.status).toBe(200);
      expect(assigned.body.data.status).toBe('ASSIGNED');
      expect(assigned.body.data.evaluator).toMatchObject({
        id: evaluatorId,
        email: 'evaluator@example.com',
        displayName: 'Eva Luator',
      });

      const assignedList = await request(app)
        .get('/admin/evaluations?status=ASSIGNED')
        .set(bearer(catalog.adminToken));
      expect(assignedList.status).toBe(200);
      expect(assignedList.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: evaluationId,
            evaluator: expect.objectContaining({ displayName: 'Eva Luator' }),
            student: expect.objectContaining({ displayName: 'Stu Dent' }),
            testSeries: expect.objectContaining({ title: 'PDF Series' }),
          }),
        ]),
      );

      const otherStart = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluator2Token));
      expect(otherStart.status).toBe(403);

      const started = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      expect(started.status).toBe(200);
      expect(started.body.data.status).toBe('IN_PROGRESS');
      expect(started.body.data.student).toMatchObject({
        email: 'student@example.com',
        displayName: 'Stu Dent',
        name: { first: 'Stu', last: 'Dent' },
      });
      expect(started.body.data.testSeries).toMatchObject({
        title: 'PDF Series',
        moduleName: 'Algebra',
        categoryName: 'Mathematics',
        categoryId: catalog.categoryId,
      });
      expect(started.body.data.attempt).toMatchObject({ attemptNumber: 1 });
      expect(started.body.data.submission.answerSheetFile.id).toBe(fileId);
      expect(started.body.data.submission.answerSheetFile).not.toHaveProperty('storageLocator');
      expect(JSON.stringify(started.body.data)).not.toContain('correctOptionId');

      const listed = await request(app)
        .get('/evaluator/evaluations')
        .set(bearer(evaluatorToken));
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: evaluationId,
            submissionType: 'PDF',
            student: expect.objectContaining({
              email: 'student@example.com',
              displayName: 'Stu Dent',
            }),
            testSeries: expect.objectContaining({
              title: 'PDF Series',
              moduleName: 'Algebra',
              categoryName: 'Mathematics',
              categoryId: catalog.categoryId,
            }),
            attempt: expect.objectContaining({ attemptNumber: 1 }),
          }),
        ]),
      );

      const listedInProgress = await request(app)
        .get('/evaluator/evaluations?status=IN_PROGRESS')
        .set(bearer(evaluatorToken));
      expect(listedInProgress.status).toBe(200);
      expect(listedInProgress.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: evaluationId, status: 'IN_PROGRESS' }),
        ]),
      );
      expect(
        listedInProgress.body.data.every((row: { status: string }) => row.status === 'IN_PROGRESS'),
      ).toBe(true);

      const listedAssigned = await request(app)
        .get('/evaluator/evaluations?status=ASSIGNED')
        .set(bearer(evaluatorToken));
      expect(listedAssigned.status).toBe(200);
      expect(listedAssigned.body.data.find((row: { id: string }) => row.id === evaluationId)).toBeUndefined();

      const listedBadStatus = await request(app)
        .get('/evaluator/evaluations?status=NOT_A_STATUS')
        .set(bearer(evaluatorToken));
      expect(listedBadStatus.status).toBe(400);

      const scored = await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 18.456, remarks: 'Clear working.' });
      expect(scored.status).toBe(200);
      expect(scored.body.data.score).toBe(18.46);
      expect(scored.body.data.maxScore).toBe(100);

      const completed = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      expect(completed.status).toBe(200);
      expect(completed.body.data.status).toBe('COMPLETED');

      const locked = await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 20 });
      expect(locked.status).toBe(409);
      expect(locked.body.error.code).toBe(ErrorCodes.EVALUATION_ALREADY_COMPLETED);

      const evaluatorFinalize = await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(evaluatorToken));
      expect(evaluatorFinalize.status).toBe(403);

      const inspected = await request(app)
        .get(`/admin/evaluations/${evaluationId}`)
        .set(bearer(catalog.adminToken));
      expect(inspected.status).toBe(200);
      expect(inspected.body.data.status).toBe('COMPLETED');
      expect(inspected.body.data.revisions).toHaveLength(1);

      const finalized = await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));
      expect(finalized.status).toBe(200);
      expect(finalized.body.data.status).toBe('FINALIZED');

      const immutable = await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 1 });
      expect(immutable.status).toBe(409);

      const firstRevision = await EvaluationRevisionModel.findOne({
        evaluationId,
        revisionNumber: 1,
      });
      expect(firstRevision!.status).toBe('FINALIZED');
      expect(firstRevision!.score).toBe(18.46);
      expect(firstRevision!.maxScore).toBe(100);

      const reopened = await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(catalog.adminToken));
      expect(reopened.status).toBe(200);
      expect(reopened.body.data.status).toBe('UNASSIGNED');
      expect(reopened.body.data.evaluatorId).toBeNull();
      expect(reopened.body.data.revisions).toHaveLength(2);
      expect(reopened.body.data.revisions.map((item: { status: string }) => item.status)).toEqual([
        'FINALIZED',
        'UNASSIGNED',
      ]);
      expect(reopened.body.data.revisions[0].score).toBe(18.46);

      const stillFinalized = await EvaluationRevisionModel.findById(firstRevision!._id);
      expect(stillFinalized!.status).toBe('FINALIZED');
      expect(stillFinalized!.score).toBe(18.46);
      expect(stillFinalized!.maxScore).toBe(100);
      expect(stillFinalized!.toObject()).not.toHaveProperty('REOPENED');

      const statuses = await EvaluationRevisionModel.distinct('status');
      expect(statuses).not.toContain('REOPENED');

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 15 });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));

      const current = await EvaluationModel.findById(evaluationId);
      const revision2 = await EvaluationRevisionModel.findById(current!.currentRevisionId);
      expect(revision2!.revisionNumber).toBe(2);
      expect(revision2!.status).toBe('FINALIZED');
      expect(revision2!.score).toBe(15);
      const original = await EvaluationRevisionModel.findById(firstRevision!._id);
      expect(original!.score).toBe(18.46);
      expect(original!.status).toBe('FINALIZED');

      const submission = await SubmissionModel.findById(submitted.body.data.submissionId);
      expect(submission!.answerSheetFile?.toString()).toBe(fileId);
      expect(await ResultModel.countDocuments({})).toBe(1);
    });

    it('evaluates an EDITOR Rich Text submission with a global score', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const doc = {
        type: 'doc',
        content: [{ type: 'paragraph', text: 'A derivative is a rate of change.' }],
      };
      const { submitted } = await submitEditor(app, catalog, doc);
      const evaluationId = await adminEvaluationId(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await studentIdFor('evaluator@example.com') });

      const started = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      expect(started.body.data.submission.editorDocument).toEqual(doc);
      expect(started.body.data.submission).not.toHaveProperty('questionMarks');

      await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 9.1 });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      const finalized = await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));
      expect(finalized.body.data.status).toBe('FINALIZED');
      expect(finalized.body.data.score).toBe(9.1);
      expect(finalized.body.data.maxScore).toBe(100);
      expect(finalized.body.data).not.toHaveProperty('questionMarks');
    });

    it('validates PDF and EDITOR scores against the snapshotted maxScore', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluatorId = await studentIdFor('evaluator@example.com');

      const { submitted: pdfSubmitted } = await submitPdf(app, catalog);
      const pdfEvaluationId = await adminEvaluationId(
        app,
        catalog.adminToken,
        pdfSubmitted.body.data.submissionId,
      );
      await request(app)
        .post(`/admin/evaluations/${pdfEvaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      await request(app)
        .post(`/evaluator/evaluations/${pdfEvaluationId}/start`)
        .set(bearer(evaluatorToken));

      const accepted = await request(app)
        .patch(`/evaluator/evaluations/${pdfEvaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 82.5 });
      expect(accepted.status).toBe(200);
      expect(accepted.body.data.score).toBe(82.5);
      expect(accepted.body.data.maxScore).toBe(100);

      const atMax = await request(app)
        .patch(`/evaluator/evaluations/${pdfEvaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 100 });
      expect(atMax.status).toBe(200);

      const over = await request(app)
        .patch(`/evaluator/evaluations/${pdfEvaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 100.01 });
      expect(over.status).toBe(400);
      expect(over.body.error.code).toBe(ErrorCodes.INVALID_SCORE);

      const negative = await request(app)
        .patch(`/evaluator/evaluations/${pdfEvaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: -1 });
      expect(negative.status).toBe(400);

      const chooseMax = await request(app)
        .patch(`/evaluator/evaluations/${pdfEvaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 80, maxScore: 50 });
      expect(chooseMax.status).toBe(400);

      const { submitted: editorSubmitted } = await submitEditor(app, catalog, { type: 'doc' });
      const editorEvaluationId = await adminEvaluationId(
        app,
        catalog.adminToken,
        editorSubmitted.body.data.submissionId,
      );
      await request(app)
        .post(`/admin/evaluations/${editorEvaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      await request(app)
        .post(`/evaluator/evaluations/${editorEvaluationId}/start`)
        .set(bearer(evaluatorToken));

      const editorOver = await request(app)
        .patch(`/evaluator/evaluations/${editorEvaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 100.01 });
      expect(editorOver.status).toBe(400);
      const editorOk = await request(app)
        .patch(`/evaluator/evaluations/${editorEvaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 82.5 });
      expect(editorOk.status).toBe(200);
      expect(editorOk.body.data.maxScore).toBe(100);
    });
  });

  describe('authorization and security', () => {
    it('blocks students, foreign evaluators, and client-controlled fields', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const studentToken = await login(app, 'student@example.com');
      const { submitted } = await submitEditor(app, catalog, { type: 'doc' });
      const evaluationId = await adminEvaluationId(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );

      const studentAssign = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(studentToken))
        .send({ evaluatorId: await studentIdFor('evaluator@example.com') });
      expect(studentAssign.status).toBe(403);

      const studentPatch = await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(studentToken))
        .send({ score: 100 });
      expect(studentPatch.status).toBe(403);

      const studentReopen = await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(studentToken));
      expect(studentReopen.status).toBe(403);

      const categoryOnAssign = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({
          evaluatorId: await studentIdFor('evaluator@example.com'),
          categoryId: catalog.otherCategoryId,
        });
      expect(categoryOnAssign.status).toBe(400);

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({
          evaluatorId: await studentIdFor('evaluator@example.com'),
        });

      const listed = await request(app)
        .get('/evaluator/evaluations')
        .set(bearer(evaluatorToken))
        .query({ evaluatorId: await studentIdFor('evaluator2@example.com') });
      expect(listed.status).toBe(400);

      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));

      const statusPatch = await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ status: 'FINALIZED', score: 8 });
      expect(statusPatch.status).toBe(400);

      const operatorPatch = await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ $set: { status: 'FINALIZED' } });
      expect(operatorPatch.status).toBe(400);

      const revisionPatch = await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ revisionNumber: 9, currentRevisionId: new Types.ObjectId().toString(), score: 8 });
      expect(revisionPatch.status).toBe(400);

      const evaluatorReopen = await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(evaluatorToken));
      expect(evaluatorReopen.status).toBe(403);

      await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 8 });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));

      const evaluatorReopenFinal = await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(evaluatorToken));
      expect(evaluatorReopenFinal.status).toBe(403);
    });
  });

  describe('concurrency', () => {
    it('allows only one evaluator assignment and one re-evaluation winner', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      await assignCategory('evaluator2@example.com', catalog.categoryId);
      const { submitted } = await submitEditor(app, catalog, { type: 'doc' });
      const evaluationId = await adminEvaluationId(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );
      const firstId = await studentIdFor('evaluator@example.com');
      const secondId = await studentIdFor('evaluator2@example.com');

      const [assignA, assignB] = await Promise.all([
        request(app)
          .post(`/admin/evaluations/${evaluationId}/assign`)
          .set(bearer(catalog.adminToken))
          .send({ evaluatorId: firstId }),
        request(app)
          .post(`/admin/evaluations/${evaluationId}/assign`)
          .set(bearer(catalog.adminToken))
          .send({ evaluatorId: secondId }),
      ]);

      const assignStatuses = [assignA.status, assignB.status].sort();
      expect(assignStatuses[0]).toBe(200);
      expect([200, 409]).toContain(assignStatuses[1]);

      const assigned = await EvaluationModel.findById(evaluationId);
      expect(['ASSIGNED', 'IN_PROGRESS']).toContain(assigned!.status);
      expect([firstId, secondId]).toContain(assigned!.evaluatorId?.toString());

      const evaluatorToken =
        assigned!.evaluatorId?.toString() === firstId
          ? await login(app, 'evaluator@example.com')
          : await login(app, 'evaluator2@example.com');
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 7 });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));

      const [reopenA, reopenB] = await Promise.all([
        request(app)
          .post(`/admin/evaluations/${evaluationId}/reopen`)
          .set(bearer(catalog.adminToken)),
        request(app)
          .post(`/admin/evaluations/${evaluationId}/reopen`)
          .set(bearer(catalog.adminToken)),
      ]);
      const reopenOk = [reopenA, reopenB].filter((response) => response.status === 200);
      expect(reopenOk.length).toBeGreaterThanOrEqual(1);
      expect(await EvaluationRevisionModel.countDocuments({ evaluationId })).toBeGreaterThanOrEqual(
        2,
      );
      const numbers = await EvaluationRevisionModel.find({ evaluationId }).sort({
        revisionNumber: 1,
      });
      const uniqueNumbers = new Set(numbers.map((item) => item.revisionNumber));
      expect(uniqueNumbers.size).toBe(numbers.length);
    });
  });
});
