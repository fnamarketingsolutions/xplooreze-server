import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
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
import { publishFromFinalizedEvaluation } from '../src/modules/results/result.service';
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
    email: 'other@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'STUDENT',
    status: 'ACTIVE',
    name: { first: 'Oth', last: 'Er' },
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

describe('Phase 11 Results & Result Publication', () => {
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
    await ResultModel.createIndexes();
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

    await request(app).post('/admin/questions').set(bearer(adminToken)).send({
      testSeriesId: editor.body.data.id,
      position: 1,
      questionText: 'Explain derivatives.',
      content: {},
    });

    return {
      adminToken,
      categoryId: category.body.data.id as string,
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

  async function assignCategory(evaluatorEmail: string, categoryId: string) {
    return evaluatorCategoryAssignmentRepository.create({
      evaluatorId: await studentIdFor(evaluatorEmail),
      categoryId,
      isActive: true,
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
    await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.editor.id);
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
    await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.pdf.id);
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
    return { studentToken, submitted };
  }

  async function evaluationIdFor(app: App, adminToken: string, submissionId: string) {
    const listed = await request(app).get('/admin/evaluations').set(bearer(adminToken));
    const found = (listed.body.data as Array<{ id: string; submissionId: string }>).find(
      (item) => item.submissionId === submissionId,
    );
    expect(found).toBeTruthy();
    return found!.id;
  }

  async function runManualEvaluation(
    app: App,
    adminToken: string,
    evaluatorToken: string,
    evaluationId: string,
    score: number,
  ) {
    const evaluatorId = await studentIdFor('evaluator@example.com');
    const assigned = await request(app)
      .post(`/admin/evaluations/${evaluationId}/assign`)
      .set(bearer(adminToken))
      .send({ evaluatorId });
    expect(assigned.status).toBe(200);
    await request(app)
      .post(`/evaluator/evaluations/${evaluationId}/start`)
      .set(bearer(evaluatorToken));
    await request(app)
      .patch(`/evaluator/evaluations/${evaluationId}`)
      .set(bearer(evaluatorToken))
      .send({ score });
    await request(app)
      .post(`/evaluator/evaluations/${evaluationId}/complete`)
      .set(bearer(evaluatorToken));
    const finalized = await request(app)
      .post(`/admin/evaluations/${evaluationId}/finalize`)
      .set(bearer(adminToken));
    expect(finalized.status).toBe(200);
    return finalized;
  }

  describe('MCQ result generation', () => {
    it('publishes a Result from the automatic FINALIZED revision without rescoring', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { studentToken, attemptId, submitted } = await submitMcq(app, catalog, [
        { questionId: catalog.mcqQuestions[0]!.id, selectedOptionId: 'B' },
        { questionId: catalog.mcqQuestions[1]!.id, selectedOptionId: 'A' },
      ]);

      expect(await ResultModel.countDocuments({})).toBe(1);
      const evaluation = await EvaluationModel.findOne({
        submissionId: submitted.body.data.submissionId,
      });
      const revision = await EvaluationRevisionModel.findById(evaluation!.currentRevisionId);
      const result = await ResultModel.findOne({ attemptId });
      expect(result!.status).toBe('PUBLISHED');
      expect(result!.score).toBe(3);
      expect(result!.maxScore).toBe(12);
      expect(result!.percentage).toBe(25);
      expect(result!.score).toBe(revision!.score);
      expect(result!.maxScore).toBe(revision!.maxScore);
      expect(result!.toObject()).not.toHaveProperty('questionMarks');
      expect(result!.toObject()).not.toHaveProperty('questionScores');

      const listed = await request(app).get('/me/results').set(bearer(studentToken));
      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0]).toMatchObject({
        attemptId,
        testSeriesId: catalog.mcq.id,
        score: 3,
        maxScore: 12,
        percentage: 25,
        status: 'PUBLISHED',
        testSeries: {
          id: catalog.mcq.id,
          title: 'MCQ Series',
          type: 'MCQ',
        },
      });
      expect(listed.body.data[0]).not.toHaveProperty('evaluationId');
      expect(listed.body.data[0]).not.toHaveProperty('remarks');
      expect(listed.body.data[0]).not.toHaveProperty('evaluatorId');
      expect(listed.body.data[0].testSeries.moduleName).toBeTruthy();
      expect(listed.body.data[0].testSeries.categoryName).toBeTruthy();

      const fetched = await request(app)
        .get(`/me/results/${result!._id.toString()}`)
        .set(bearer(studentToken));
      expect(fetched.status).toBe(200);
      expect(fetched.body.data.score).toBe(3);
      expect(fetched.body.data.catalog.testSeries).toMatchObject({
        id: catalog.mcq.id,
        title: 'MCQ Series',
        type: 'MCQ',
        evaluationMode: 'AUTOMATIC',
      });
      expect(fetched.body.data.catalog.module).toMatchObject({ name: 'Algebra' });
      expect(fetched.body.data.catalog.category).toMatchObject({ name: 'Mathematics' });
      expect(fetched.body.data.attempt).toMatchObject({
        id: attemptId,
        attemptNumber: 1,
        status: 'SUBMITTED',
      });
      expect(fetched.body.data.attempt.questions).toBeDefined();
      expect(fetched.body.data.attempt.questions[0].content.correctOptionId).toBeUndefined();
      expect(fetched.body.data.testSeries).toMatchObject({
        id: catalog.mcq.id,
        title: 'MCQ Series',
        type: 'MCQ',
      });

      await request(app)
        .patch(`/admin/test-series/${catalog.mcq.id}`)
        .set(bearer(catalog.adminToken))
        .send({ scoring: { correctMarks: 5, incorrectMarks: -2, unansweredMarks: 0 } });

      const repeat = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(repeat.status).toBe(200);
      expect(await ResultModel.countDocuments({})).toBe(1);
      const unchanged = await ResultModel.findById(result!._id);
      expect(unchanged!.score).toBe(3);
      expect(unchanged!.maxScore).toBe(12);

      const submission = await SubmissionModel.findById(submitted.body.data.submissionId);
      expect(submission!.answers).toBeDefined();
      const stillRevision = await EvaluationRevisionModel.findById(revision!._id);
      expect(stillRevision!.score).toBe(3);
      expect(stillRevision!.status).toBe('FINALIZED');

      const created = await AuditLogModel.countDocuments({ action: 'RESULT_CREATED' });
      const published = await AuditLogModel.countDocuments({ action: 'RESULT_PUBLISHED' });
      expect(created).toBe(1);
      expect(published).toBe(1);
    });
  });

  describe('PDF and EDITOR results', () => {
    it('publishes a PDF Result from the evaluator finalized global score', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const { studentToken, submitted } = await submitPdf(app, catalog);
      expect(await ResultModel.countDocuments({})).toBe(0);

      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );
      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 80);

      expect(await ResultModel.countDocuments({})).toBe(1);
      const result = await ResultModel.findOne({ attemptId: submitted.body.data.attemptId });
      expect(result!.status).toBe('PUBLISHED');
      expect(result!.score).toBe(80);
      expect(result!.maxScore).toBe(100);
      expect(result!.percentage).toBe(80);
      expect(result!.toObject()).not.toHaveProperty('questionMarks');

      const studentView = await request(app)
        .get(`/me/results/${result!._id.toString()}`)
        .set(bearer(studentToken));
      expect(studentView.status).toBe(200);
      expect(studentView.body.data.score).toBe(80);

      const evaluatorPatch = await request(app)
        .patch(`/results/${result!._id.toString()}`)
        .set(bearer(evaluatorToken))
        .send({ score: 1 });
      expect(evaluatorPatch.status).toBe(404);

      const evaluatorPublish = await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(evaluatorToken));
      expect(evaluatorPublish.status).toBe(403);

      const locked = await ResultModel.findById(result!._id);
      expect(locked!.score).toBe(80);
    });

    it('publishes an EDITOR Result from the finalized global score with no question-level marks', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const { submitted } = await submitEditor(app, catalog, {
        type: 'doc',
        content: [{ type: 'paragraph', text: 'A derivative is a rate of change.' }],
      });
      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );
      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 9.1);

      const result = await ResultModel.findOne({ attemptId: submitted.body.data.attemptId });
      expect(result!.score).toBe(9.1);
      expect(result!.maxScore).toBe(100);
      expect(result!.percentage).toBe(9.1);
      expect(result!.status).toBe('PUBLISHED');
      expect(result!.toObject()).not.toHaveProperty('questionMarks');
      const submission = await SubmissionModel.findById(submitted.body.data.submissionId);
      expect(submission!.editorDocument).toEqual({
        type: 'doc',
        content: [{ type: 'paragraph', text: 'A derivative is a rate of change.' }],
      });
    });
  });

  describe('re-evaluation', () => {
    it('keeps the published Result until the new revision is FINALIZED', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluatorId = await studentIdFor('evaluator@example.com');
      const { submitted } = await submitPdf(app, catalog);
      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );

      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 80);
      const first = await ResultModel.findOne({ attemptId: submitted.body.data.attemptId });
      expect(first!.score).toBe(80);
      const revision1 = await EvaluationRevisionModel.findOne({
        evaluationId,
        revisionNumber: 1,
      });

      const reopened = await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(catalog.adminToken));
      expect(reopened.status).toBe(200);
      expect(reopened.body.data.status).toBe('UNASSIGNED');
      expect((await ResultModel.findById(first!._id))!.score).toBe(80);

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      expect((await ResultModel.findById(first!._id))!.score).toBe(80);

      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      expect((await ResultModel.findById(first!._id))!.score).toBe(80);

      await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 92 });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      expect((await ResultModel.findById(first!._id))!.score).toBe(80);
      expect(await ResultModel.countDocuments({})).toBe(1);

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));

      expect(await ResultModel.countDocuments({})).toBe(1);
      const updated = await ResultModel.findById(first!._id);
      expect(updated!.score).toBe(92);
      expect(updated!.status).toBe('PUBLISHED');

      const original = await EvaluationRevisionModel.findById(revision1!._id);
      expect(original!.status).toBe('FINALIZED');
      expect(original!.score).toBe(80);
      const revision2 = await EvaluationRevisionModel.findOne({
        evaluationId,
        revisionNumber: 2,
      });
      expect(revision2!.status).toBe('FINALIZED');
      expect(revision2!.score).toBe(92);

      const audits = await AuditLogModel.countDocuments({
        action: 'RESULT_UPDATED_AFTER_RE_EVALUATION',
      });
      expect(audits).toBe(1);
    });

    it('leaves the latest finalized Result in place while a later revision is in progress', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const evaluatorId = await studentIdFor('evaluator@example.com');
      const { submitted } = await submitPdf(app, catalog);
      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );

      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 80);
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(catalog.adminToken));
      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 92);
      expect((await ResultModel.findOne({}))!.score).toBe(92);

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(catalog.adminToken));
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      expect((await ResultModel.findOne({}))!.score).toBe(92);

      await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 70 });
      await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/finalize`)
        .set(bearer(catalog.adminToken));

      expect(await ResultModel.countDocuments({})).toBe(1);
      expect((await ResultModel.findOne({}))!.score).toBe(70);

      const revisions = await EvaluationRevisionModel.find({ evaluationId }).sort({
        revisionNumber: 1,
      });
      expect(revisions.map((item) => item.score)).toEqual([80, 92, 70]);
      expect(revisions.every((item) => item.status === 'FINALIZED')).toBe(true);
    });
  });

  describe('security', () => {
    it('enforces ownership, roles, and rejects client-controlled Result fields', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { studentToken, submitted } = await submitMcq(app, catalog, [
        { questionId: catalog.mcqQuestions[0]!.id, selectedOptionId: 'B' },
      ]);
      const result = await ResultModel.findOne({ attemptId: submitted.body.data.attemptId });
      const resultId = result!._id.toString();
      const otherToken = await login(app, 'other@example.com');
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const adminToken = catalog.adminToken;

      const foreign = await request(app).get(`/me/results/${resultId}`).set(bearer(otherToken));
      expect(foreign.status).toBe(404);

      const otherList = await request(app).get('/me/results').set(bearer(otherToken));
      expect(otherList.status).toBe(200);
      expect(otherList.body.data).toHaveLength(0);

      const studentMutate = await request(app)
        .patch(`/results/${resultId}`)
        .set(bearer(studentToken))
        .send({ score: 100 });
      expect(studentMutate.status).toBe(404);

      const studentCreate = await request(app)
        .post('/results')
        .set(bearer(studentToken))
        .send({ score: 100, attemptId: submitted.body.data.attemptId });
      expect(studentCreate.status).toBe(404);

      const evaluatorMutate = await request(app)
        .patch(`/results/${resultId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 1 });
      expect(evaluatorMutate.status).toBe(404);

      const evaluatorList = await request(app).get('/me/results').set(bearer(evaluatorToken));
      expect(evaluatorList.status).toBe(403);

      const evaluatorAdmin = await request(app).get('/admin/results').set(bearer(evaluatorToken));
      expect(evaluatorAdmin.status).toBe(403);

      const studentAdmin = await request(app).get('/admin/results').set(bearer(studentToken));
      expect(studentAdmin.status).toBe(403);

      const clientStudentId = await request(app)
        .get('/me/results')
        .query({ studentId: await studentIdFor('other@example.com') })
        .set(bearer(studentToken));
      expect(clientStudentId.status).toBe(400);

      const clientAttempt = await request(app)
        .get('/me/results')
        .query({ attemptId: submitted.body.data.attemptId })
        .set(bearer(studentToken));
      expect(clientAttempt.status).toBe(400);

      const operators = await request(app)
        .get('/me/results')
        .query({ $gt: '1' })
        .set(bearer(studentToken));
      expect(operators.status).toBe(400);
      expect(operators.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const unknown = await request(app)
        .get('/me/results')
        .query({ foo: 'bar' })
        .set(bearer(studentToken));
      expect(unknown.status).toBe(400);

      const adminList = await request(app).get('/admin/results').set(bearer(adminToken));
      expect(adminList.status).toBe(200);
      expect(adminList.body.data).toHaveLength(1);
      expect(adminList.body.data[0].studentId).toBe(await studentIdFor('student@example.com'));

      const adminGet = await request(app).get(`/admin/results/${resultId}`).set(bearer(adminToken));
      expect(adminGet.status).toBe(200);
      expect(adminGet.body.data.score).toBe(result!.score);

      const pending = await ResultModel.create({
        studentId: await studentIdFor('student@example.com'),
        testSeriesId: catalog.editor.id,
        attemptId: new Types.ObjectId(),
        submissionId: new Types.ObjectId(),
        score: 1,
        maxScore: 1,
        percentage: 100,
        status: 'PENDING',
      });
      const pendingGet = await request(app)
        .get(`/me/results/${pending._id.toString()}`)
        .set(bearer(studentToken));
      expect(pendingGet.status).toBe(404);
      const adminPending = await request(app)
        .get(`/admin/results/${pending._id.toString()}`)
        .set(bearer(adminToken));
      expect(adminPending.status).toBe(200);
      expect(adminPending.body.data.status).toBe('PENDING');
    });

    it('does not hide a published Result after entitlement expiry or catalog archive', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { studentToken, submitted } = await submitMcq(app, catalog, [
        { questionId: catalog.mcqQuestions[0]!.id, selectedOptionId: 'B' },
      ]);
      const result = await ResultModel.findOne({ attemptId: submitted.body.data.attemptId });

      await EntitlementModel.updateMany(
        {},
        { $set: { status: 'EXPIRED', expiresAt: new Date(0) } },
      );
      await request(app)
        .patch(`/admin/test-series/${catalog.mcq.id}`)
        .set(bearer(catalog.adminToken))
        .send({ status: 'ARCHIVED' });

      const fetched = await request(app)
        .get(`/me/results/${result!._id.toString()}`)
        .set(bearer(studentToken));
      expect(fetched.status).toBe(200);
      expect(fetched.body.data.score).toBe(result!.score);
    });
  });

  describe('admin result detail expansion', () => {
    it('expands student, catalog path, attempt, and automatic evaluation for an MCQ result', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const { attemptId, submitted } = await submitMcq(app, catalog, [
        { questionId: catalog.mcqQuestions[0]!.id, selectedOptionId: 'B' },
      ]);
      const result = await ResultModel.findOne({ attemptId });

      const detail = await request(app)
        .get(`/admin/results/${result!._id.toString()}`)
        .set(bearer(catalog.adminToken));
      expect(detail.status).toBe(200);

      expect(detail.body.data.student).toEqual({
        id: await studentIdFor('student@example.com'),
        name: 'Stu Dent',
        email: 'student@example.com',
        mobileNumber: null,
      });
      expect(detail.body.data.catalog.testSeries).toMatchObject({
        id: catalog.mcq.id,
        title: 'MCQ Series',
        type: 'MCQ',
        status: 'ACTIVE',
        maxAttempts: null,
      });
      expect(detail.body.data.catalog.module).toMatchObject({ name: 'Algebra' });
      expect(detail.body.data.catalog.category).toMatchObject({ name: 'Mathematics' });
      expect(detail.body.data.attempt).toMatchObject({
        id: attemptId,
        attemptNumber: 1,
        status: 'SUBMITTED',
      });
      expect(detail.body.data.attempt.startedAt).toBeTruthy();
      expect(detail.body.data.attempt.examEndsAt).toBeTruthy();
      expect(detail.body.data.attempt.submittedAt).toBeTruthy();
      expect(detail.body.data.evaluation).toMatchObject({
        mode: 'AUTOMATIC',
        status: 'FINALIZED',
        revisionNumber: 1,
        evaluator: null,
      });
      expect(detail.body.data.evaluation.finalizedAt).toBeTruthy();

      // The scalar contract the Admin list and existing clients rely on is unchanged.
      expect(detail.body.data).toMatchObject({
        id: result!._id.toString(),
        submissionId: submitted.body.data.submissionId,
        score: 4,
        maxScore: 12,
        status: 'PUBLISHED',
      });
    });

    it('names the evaluator who produced the finalized revision for a manual result', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const { submitted } = await submitPdf(app, catalog);
      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );
      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 80);
      const result = await ResultModel.findOne({ attemptId: submitted.body.data.attemptId });

      const detail = await request(app)
        .get(`/admin/results/${result!._id.toString()}`)
        .set(bearer(catalog.adminToken));
      expect(detail.status).toBe(200);
      expect(detail.body.data.catalog.testSeries.type).toBe('PDF');
      expect(detail.body.data.evaluation).toMatchObject({
        id: evaluationId,
        mode: 'MANUAL',
        status: 'FINALIZED',
        revisionNumber: 1,
        evaluator: {
          id: await studentIdFor('evaluator@example.com'),
          name: 'Eva Luator',
          email: 'evaluator@example.com',
          mobileNumber: null,
        },
      });
    });

    it('reports unresolved references as null instead of failing the read', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const orphan = await ResultModel.create({
        studentId: await studentIdFor('student@example.com'),
        testSeriesId: new Types.ObjectId(),
        attemptId: new Types.ObjectId(),
        submissionId: new Types.ObjectId(),
        score: 1,
        maxScore: 2,
        percentage: 50,
        status: 'PENDING',
      });

      const detail = await request(app)
        .get(`/admin/results/${orphan._id.toString()}`)
        .set(bearer(catalog.adminToken));
      expect(detail.status).toBe(200);
      expect(detail.body.data.status).toBe('PENDING');
      expect(detail.body.data.student).toMatchObject({ name: 'Stu Dent' });
      expect(detail.body.data.catalog).toBeNull();
      expect(detail.body.data.attempt).toBeNull();
      expect(detail.body.data.evaluation).toBeNull();
    });
  });

  describe('concurrency and idempotency', () => {
    it('creates one Result for concurrent MCQ submission and concurrent publication', async () => {
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
          answers: [{ questionId: catalog.mcqQuestions[0]!.id, selectedOptionId: 'B' }],
        });

      const [first, second] = await Promise.all([
        request(app).post(`/attempts/${started.body.data.id}/submit`).set(bearer(studentToken)),
        request(app).post(`/attempts/${started.body.data.id}/submit`).set(bearer(studentToken)),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await ResultModel.countDocuments({})).toBe(1);

      const evaluation = await EvaluationModel.findOne({});
      const actor = { userId: await studentIdFor('admin@example.com'), role: 'ADMIN' as const };
      await Promise.all([
        publishFromFinalizedEvaluation(evaluation!._id.toString(), actor),
        publishFromFinalizedEvaluation(evaluation!._id.toString(), actor),
      ]);
      expect(await ResultModel.countDocuments({})).toBe(1);
      expect(await AuditLogModel.countDocuments({ action: 'RESULT_CREATED' })).toBe(1);
    });

    it('does not replace a published Result from an in-progress re-evaluation', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const { submitted } = await submitPdf(app, catalog);
      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );
      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 80);
      await request(app)
        .post(`/admin/evaluations/${evaluationId}/reopen`)
        .set(bearer(catalog.adminToken));

      const actor = { userId: await studentIdFor('admin@example.com'), role: 'ADMIN' as const };
      await Promise.all([
        publishFromFinalizedEvaluation(evaluationId, actor),
        publishFromFinalizedEvaluation(evaluationId, actor),
      ]);

      expect(await ResultModel.countDocuments({})).toBe(1);
      expect((await ResultModel.findOne({}))!.score).toBe(80);
      const current = await EvaluationModel.findById(evaluationId);
      expect(current!.status).toBe('UNASSIGNED');
    });
  });

  describe('maxScore historical stability', () => {
    it('keeps the Attempt snapshot maxScore through evaluation and result after Test Series changes', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.pdf.id);

      await request(app)
        .patch(`/admin/test-series/${catalog.pdf.id}`)
        .set(bearer(catalog.adminToken))
        .send({ scoring: { maxScore: 100 } });

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);
      expect(started.body.data.configuration.scoring.maxScore).toBe(100);

      await request(app)
        .patch(`/admin/test-series/${catalog.pdf.id}`)
        .set(bearer(catalog.adminToken))
        .send({ scoring: { maxScore: 120 } });

      const storedAttempt = await AttemptModel.findById(started.body.data.id);
      expect(storedAttempt!.configurationSnapshot.scoring.maxScore).toBe(100);

      await AttemptModel.findByIdAndUpdate(started.body.data.id, {
        examEndsAt: new Date(Date.now() - 1000),
      });
      const pending = await request(app)
        .get(`/me/attempts/${started.body.data.id}`)
        .set(bearer(studentToken));
      expect(pending.body.data.status).toBe('UPLOAD_PENDING');
      const body = pdfBytes('historical-answer');
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

      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );
      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 82.5);

      const revision = await EvaluationRevisionModel.findOne({
        evaluationId,
        revisionNumber: 1,
      });
      expect(revision!.score).toBe(82.5);
      expect(revision!.maxScore).toBe(100);
      expect(revision!.status).toBe('FINALIZED');

      const result = await ResultModel.findOne({ attemptId: started.body.data.id });
      expect(result!.score).toBe(82.5);
      expect(result!.maxScore).toBe(100);
      expect(result!.percentage).toBe(82.5);
    });

    it('publishes a Result for maxScore 50 and score 42.50 as 85 percent', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      await assignCategory('evaluator@example.com', catalog.categoryId);
      const evaluatorToken = await login(app, 'evaluator@example.com');

      await request(app)
        .patch(`/admin/test-series/${catalog.pdf.id}`)
        .set(bearer(catalog.adminToken))
        .send({ scoring: { maxScore: 50 } });

      const { submitted } = await submitPdf(app, catalog);
      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );
      await runManualEvaluation(app, catalog.adminToken, evaluatorToken, evaluationId, 42.5);

      const result = await ResultModel.findOne({ attemptId: submitted.body.data.attemptId });
      expect(result!.score).toBe(42.5);
      expect(result!.maxScore).toBe(50);
      expect(result!.percentage).toBe(85);
    });
  });
});
