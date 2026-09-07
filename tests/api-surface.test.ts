import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
import { PurchaseModel } from '../src/database/models/purchase.model';
import { QuestionModel } from '../src/database/models/question.model';
import { ResultModel } from '../src/database/models/result.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../src/database/models/conventions';
import { evaluatorCategoryAssignmentRepository } from '../src/database/repositories/assignments.repository';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword } from '../src/modules/auth/password';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const PRICE_PAISE = 49900;
const mcqScoring = { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 };

type App = ReturnType<typeof createApp>;

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

describe('Phase 23 API surface migration', () => {
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

    const question = await request(app)
      .post('/admin/questions')
      .set(bearer(adminToken))
      .send({
        testSeriesId: mcq.body.data.id,
        position: 1,
        questionText: 'Question 1',
        content: {
          options: [
            { id: 'A', text: '3' },
            { id: 'B', text: '4' },
          ],
          correctOptionId: 'B',
        },
      });
    expect(question.status).toBe(201);

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
      mcq: mcq.body.data as { id: string },
      editor: editor.body.data as { id: string },
      mcqQuestionId: question.body.data.id as string,
    };
  }

  async function grantPaidEntitlement(
    studentId: string,
    testSeriesId: string,
    purchaseId?: string,
  ) {
    const grantedAt = new Date();
    return EntitlementModel.create({
      studentId,
      testSeriesId,
      purchaseId: purchaseId ?? new Types.ObjectId(),
      status: 'ACTIVE',
      grantedAt,
      expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
    });
  }

  async function submitEditor(app: App, catalog: Awaited<ReturnType<typeof seedCatalog>>) {
    const studentToken = await login(app, 'student@example.com');
    const studentId = await userIdFor('student@example.com');
    await grantPaidEntitlement(studentId, catalog.editor.id);

    const started = await request(app)
      .post('/attempts')
      .set(bearer(studentToken))
      .send({ testSeriesId: catalog.editor.id });
    expect(started.status).toBe(201);

    await request(app)
      .patch(`/attempts/${started.body.data.id}/answers`)
      .set(bearer(studentToken))
      .send({ version: 1, editorDocument: { type: 'doc' } });

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

  describe('evaluator evaluations namespace', () => {
    it('serves evaluator evaluation operations only under /evaluator/evaluations', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const assignment = await evaluatorCategoryAssignmentRepository.create({
        evaluatorId: await userIdFor('evaluator@example.com'),
        categoryId: catalog.categoryId,
        isActive: true,
      });
      await evaluatorCategoryAssignmentRepository.create({
        evaluatorId: await userIdFor('evaluator2@example.com'),
        categoryId: catalog.categoryId,
        isActive: true,
      });

      const evaluatorToken = await login(app, 'evaluator@example.com');
      const otherEvaluatorToken = await login(app, 'evaluator2@example.com');
      const studentToken = await login(app, 'student@example.com');
      const { submitted } = await submitEditor(app, catalog);
      const evaluationId = await evaluationIdFor(
        app,
        catalog.adminToken,
        submitted.body.data.submissionId,
      );

      await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: await userIdFor('evaluator@example.com') });

      const studentList = await request(app)
        .get('/evaluator/evaluations')
        .set(bearer(studentToken));
      expect(studentList.status).toBe(403);

      const adminList = await request(app)
        .get('/evaluator/evaluations')
        .set(bearer(catalog.adminToken));
      expect(adminList.status).toBe(403);

      const listed = await request(app).get('/evaluator/evaluations').set(bearer(evaluatorToken));
      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].id).toBe(evaluationId);

      const clientEvaluatorId = await request(app)
        .get('/evaluator/evaluations')
        .query({ evaluatorId: await userIdFor('evaluator2@example.com') })
        .set(bearer(evaluatorToken));
      expect(clientEvaluatorId.status).toBe(400);

      const fetched = await request(app)
        .get(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken));
      expect(fetched.status).toBe(200);

      const otherGet = await request(app)
        .get(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(otherEvaluatorToken));
      expect(otherGet.status).toBe(403);
      expect(otherGet.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_ASSIGNED);

      const otherStart = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(otherEvaluatorToken));
      expect(otherStart.status).toBe(403);

      const started = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      expect(started.status).toBe(200);
      expect(started.body.data.status).toBe('IN_PROGRESS');

      const patched = await request(app)
        .patch(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken))
        .send({ score: 72.5, remarks: 'Clear working.' });
      expect(patched.status).toBe(200);
      expect(patched.body.data.score).toBe(72.5);

      const completed = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/complete`)
        .set(bearer(evaluatorToken));
      expect(completed.status).toBe(200);
      expect(completed.body.data.status).toBe('COMPLETED');

      const deactivated = await request(app)
        .patch(`/admin/evaluator-category-assignments/${assignment._id.toString()}`)
        .set(bearer(catalog.adminToken))
        .send({ isActive: false });
      expect(deactivated.status).toBe(200);

      const inactiveGet = await request(app)
        .get(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken));
      expect(inactiveGet.status).toBe(403);
      expect(inactiveGet.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_AUTHORIZED);

      await request(app)
        .patch(`/admin/evaluator-category-assignments/${assignment._id.toString()}`)
        .set(bearer(catalog.adminToken))
        .send({ isActive: true });

      const reactivated = await request(app)
        .get(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken));
      expect(reactivated.status).toBe(200);

      const oldList = await request(app).get('/evaluations').set(bearer(evaluatorToken));
      expect(oldList.status).toBe(404);
      expect(oldList.body.error.code).toBe(ErrorCodes.ROUTE_NOT_FOUND);

      const oldGet = await request(app)
        .get(`/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken));
      expect(oldGet.status).toBe(404);

      const oldStart = await request(app)
        .post(`/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      expect(oldStart.status).toBe(404);

      const adminOnly = await request(app)
        .get(`/admin/evaluations/${evaluationId}`)
        .set(bearer(catalog.adminToken));
      expect(adminOnly.status).toBe(200);
      expect(adminOnly.body.data.status).toBe('COMPLETED');
    });
  });

  describe('student /me list and read', () => {
    it('scopes purchases, entitlements, attempts, and results to the authenticated student', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const otherToken = await login(app, 'other@example.com');
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const studentId = await userIdFor('student@example.com');
      const otherId = await userIdFor('other@example.com');

      const ownPurchase = await PurchaseModel.create({
        studentId,
        testSeriesId: catalog.editor.id,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'PAID',
        razorpayOrderId: 'order_own',
        razorpayPaymentId: 'pay_own',
      });
      const otherPurchase = await PurchaseModel.create({
        studentId: otherId,
        testSeriesId: catalog.editor.id,
        amount: PRICE_PAISE,
        currency: 'INR',
        status: 'PAID',
        razorpayOrderId: 'order_other',
        razorpayPaymentId: 'pay_other',
      });
      const ownEntitlement = await grantPaidEntitlement(
        studentId,
        catalog.editor.id,
        ownPurchase._id.toString(),
      );
      const otherEntitlement = await grantPaidEntitlement(
        otherId,
        catalog.editor.id,
        otherPurchase._id.toString(),
      );

      const purchases = await request(app).get('/me/purchases').set(bearer(studentToken));
      expect(purchases.status).toBe(200);
      expect(purchases.body.data).toHaveLength(1);
      expect(purchases.body.data[0].id).toBe(ownPurchase._id.toString());
      expect(purchases.body.data[0].status).toBe('PAID');
      expect(purchases.body.data[0]).not.toHaveProperty('REFUNDED');
      expect(purchases.body.data[0].testSeries).toEqual({
        id: catalog.editor.id,
        title: 'Editor Series',
        type: 'EDITOR',
        moduleName: 'Algebra',
        categoryId: catalog.categoryId,
        categoryName: 'Mathematics',
      });

      const selector = await request(app)
        .get('/me/purchases')
        .query({ studentId: otherId, userId: otherId })
        .set(bearer(studentToken));
      expect(selector.status).toBe(200);
      expect(selector.body.data).toHaveLength(1);
      expect(selector.body.data[0].id).toBe(ownPurchase._id.toString());

      const ownPurchaseGet = await request(app)
        .get(`/me/purchases/${ownPurchase._id.toString()}`)
        .set(bearer(studentToken));
      expect(ownPurchaseGet.status).toBe(200);
      expect(ownPurchaseGet.body.data.testSeries).toEqual({
        id: catalog.editor.id,
        title: 'Editor Series',
        type: 'EDITOR',
        moduleName: 'Algebra',
        categoryId: catalog.categoryId,
        categoryName: 'Mathematics',
      });

      const foreignPurchase = await request(app)
        .get(`/me/purchases/${otherPurchase._id.toString()}`)
        .set(bearer(studentToken));
      expect(foreignPurchase.status).toBe(404);

      const entitlements = await request(app).get('/me/entitlements').set(bearer(studentToken));
      expect(entitlements.status).toBe(200);
      expect(entitlements.body.data).toHaveLength(1);
      expect(entitlements.body.data[0].id).toBe(ownEntitlement._id.toString());
      expect(entitlements.body.data[0].status).toBe('ACTIVE');
      expect(entitlements.body.data[0].testSeries).toEqual({
        id: catalog.editor.id,
        title: 'Editor Series',
        type: 'EDITOR',
        moduleName: 'Algebra',
        categoryId: catalog.categoryId,
        categoryName: 'Mathematics',
      });

      const ownEntitlementGet = await request(app)
        .get(`/me/entitlements/${ownEntitlement._id.toString()}`)
        .set(bearer(studentToken));
      expect(ownEntitlementGet.status).toBe(200);
      expect(ownEntitlementGet.body.data.testSeries).toEqual({
        id: catalog.editor.id,
        title: 'Editor Series',
        type: 'EDITOR',
        moduleName: 'Algebra',
        categoryId: catalog.categoryId,
        categoryName: 'Mathematics',
      });

      const foreignEntitlement = await request(app)
        .get(`/me/entitlements/${otherEntitlement._id.toString()}`)
        .set(bearer(studentToken));
      expect(foreignEntitlement.status).toBe(404);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(started.status).toBe(201);
      const attemptId = started.body.data.id as string;

      const attempts = await request(app).get('/me/attempts').set(bearer(studentToken));
      expect(attempts.status).toBe(200);
      expect(attempts.body.data).toHaveLength(1);
      expect(attempts.body.data[0].id).toBe(attemptId);

      const otherAttempts = await request(app).get('/me/attempts').set(bearer(otherToken));
      expect(otherAttempts.status).toBe(200);
      expect(otherAttempts.body.data).toHaveLength(0);

      const attemptDetail = await request(app)
        .get(`/me/attempts/${attemptId}`)
        .set(bearer(studentToken));
      expect(attemptDetail.status).toBe(200);
      expect(attemptDetail.body.data.examEndsAt).toBeTruthy();

      const foreignAttempt = await request(app)
        .get(`/me/attempts/${attemptId}`)
        .set(bearer(otherToken));
      expect(foreignAttempt.status).toBe(404);

      const active = await request(app)
        .get('/me/attempts/active')
        .query({ testSeriesId: catalog.mcq.id })
        .set(bearer(studentToken));
      expect(active.status).toBe(200);
      expect(active.body.data.id).toBe(attemptId);

      await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestionId, selectedOptionId: 'B' }],
        });
      const submitted = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);

      const historical = await request(app)
        .get(`/me/attempts/${attemptId}`)
        .set(bearer(studentToken));
      expect(historical.status).toBe(200);
      expect(historical.body.data.status).toBe('SUBMITTED');

      const results = await request(app).get('/me/results').set(bearer(studentToken));
      expect(results.status).toBe(200);
      expect(results.body.data).toHaveLength(1);
      const resultId = results.body.data[0].id as string;
      expect(results.body.data[0].status).toBe('PUBLISHED');

      const resultDetail = await request(app)
        .get(`/me/results/${resultId}`)
        .set(bearer(studentToken));
      expect(resultDetail.status).toBe(200);

      const otherResults = await request(app).get('/me/results').set(bearer(otherToken));
      expect(otherResults.status).toBe(200);
      expect(otherResults.body.data).toHaveLength(0);

      const foreignResult = await request(app)
        .get(`/me/results/${resultId}`)
        .set(bearer(otherToken));
      expect(foreignResult.status).toBe(404);

      const clientResultStudentId = await request(app)
        .get('/me/results')
        .query({ studentId: otherId })
        .set(bearer(studentToken));
      expect(clientResultStudentId.status).toBe(400);

      const evaluatorMe = await request(app).get('/me/purchases').set(bearer(evaluatorToken));
      expect(evaluatorMe.status).toBe(403);

      const adminMe = await request(app).get('/me/results').set(bearer(catalog.adminToken));
      expect(adminMe.status).toBe(403);

      const identitySelector = await request(app)
        .get(`/me/users/${otherId}`)
        .set(bearer(studentToken));
      expect(identitySelector.status).toBe(404);

      const oldPurchases = await request(app).get('/purchases').set(bearer(studentToken));
      expect(oldPurchases.status).toBe(404);
      const oldEntitlements = await request(app).get('/entitlements').set(bearer(studentToken));
      expect(oldEntitlements.status).toBe(404);
      const oldAttempts = await request(app).get('/attempts').set(bearer(studentToken));
      expect(oldAttempts.status).toBe(404);
      const oldAttemptDetail = await request(app)
        .get(`/attempts/${attemptId}`)
        .set(bearer(studentToken));
      expect(oldAttemptDetail.status).toBe(404);
      const oldResults = await request(app).get('/results').set(bearer(studentToken));
      expect(oldResults.status).toBe(404);
    });
  });

  describe('resource-scoped runtime and admin routes', () => {
    it('keeps mutations, file download, and admin routes on their existing paths', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const fileId = new Types.ObjectId().toString();

      const unauthStart = await request(app)
        .post('/attempts')
        .send({ testSeriesId: catalog.mcq.id });
      expect(unauthStart.status).toBe(401);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(started.status).toBe(201);
      const attemptId = started.body.data.id as string;

      const autosave = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestionId, selectedOptionId: 'B' }],
        });
      expect(autosave.status).toBe(200);

      const submit = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(submit.status).toBe(200);

      const meStart = await request(app)
        .post('/me/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(meStart.status).toBe(404);

      const meSubmit = await request(app)
        .post(`/me/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(meSubmit.status).toBe(404);

      const mePurchase = await request(app)
        .post('/me/purchases')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(mePurchase.status).toBe(404);

      const unauthPurchase = await request(app)
        .post('/purchases')
        .send({ testSeriesId: catalog.editor.id });
      expect(unauthPurchase.status).toBe(401);

      const download = await request(app)
        .get(`/files/${fileId}/download`)
        .set(bearer(studentToken));
      expect(download.status).toBe(404);
      expect(download.body.error.code).not.toBe(ErrorCodes.ROUTE_NOT_FOUND);

      const meFile = await request(app)
        .get(`/me/files/${fileId}/download`)
        .set(bearer(studentToken));
      expect(meFile.status).toBe(404);
      expect(meFile.body.error.code).toBe(ErrorCodes.ROUTE_NOT_FOUND);

      const meAttemptDownload = await request(app)
        .get(`/me/attempts/${attemptId}/download`)
        .set(bearer(studentToken));
      expect(meAttemptDownload.status).toBe(404);

      const unauthUpload = await request(app).post(`/attempts/${attemptId}/upload-url`).send({
        originalName: 'answer.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      });
      expect(unauthUpload.status).toBe(401);

      const adminEvaluations = await request(app)
        .get('/admin/evaluations')
        .set(bearer(catalog.adminToken));
      expect(adminEvaluations.status).toBe(200);

      const studentAdminEvaluations = await request(app)
        .get('/admin/evaluations')
        .set(bearer(studentToken));
      expect(studentAdminEvaluations.status).toBe(403);

      const evaluatorAdminEvaluations = await request(app)
        .get('/admin/evaluations')
        .set(bearer(evaluatorToken));
      expect(evaluatorAdminEvaluations.status).toBe(403);

      const adminResults = await request(app).get('/admin/results').set(bearer(catalog.adminToken));
      expect(adminResults.status).toBe(200);

      const versioned = await request(app).get('/api/v1/me/purchases').set(bearer(studentToken));
      expect(versioned.status).toBe(404);
      const versionedEvaluator = await request(app)
        .get('/api/v1/evaluator/evaluations')
        .set(bearer(evaluatorToken));
      expect(versionedEvaluator.status).toBe(404);
    });
  });
});
