import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
import { CategoryModel } from '../src/database/models/category.model';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { ModuleModel } from '../src/database/models/module.model';
import { PurchaseModel } from '../src/database/models/purchase.model';
import { ResultModel } from '../src/database/models/result.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword } from '../src/modules/auth/password';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';

type App = ReturnType<typeof createApp>;

function bearer(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-exam-session-id': '11111111-1111-4111-8111-111111111111',
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

describe('Admin analytics overview', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await ModuleModel.createIndexes();
    await TestSeriesModel.createIndexes();
    await PurchaseModel.createIndexes();
    await EntitlementModel.createIndexes();
    await AttemptModel.createIndexes();
    await SubmissionModel.createIndexes();
    await EvaluationModel.createIndexes();
    await ResultModel.createIndexes();
  });

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
    });
    await seedUsers();
  });

  afterEach(async () => {
    await clearMemoryMongo();
  });

  it('rejects unauthenticated and non-admin access', async () => {
    const app = createApp();
    const studentToken = await login(app, 'student@example.com');

    const unauth = await request(app).get('/admin/analytics/overview');
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe(ErrorCodes.AUTHENTICATION_REQUIRED);

    const forbidden = await request(app).get('/admin/analytics/overview').set(bearer(studentToken));
    expect(forbidden.status).toBe(403);
  });

  it('returns zeroed overview shape for empty platform', async () => {
    const app = createApp();
    const adminToken = await login(app, 'admin@example.com');

    const response = await request(app).get('/admin/analytics/overview').set(bearer(adminToken));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const data = response.body.data;
    expect(data.windowDays).toBe(30);
    expect(data.kpis).toEqual({
      activeStudents: 1,
      paidRevenuePaise: 0,
      activeEntitlements: 0,
      attemptsInFlight: 0,
      evalBacklog: 0,
    });
    expect(data.evaluationQueue).toEqual({
      UNASSIGNED: 0,
      ASSIGNED: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      FINALIZED: 0,
    });
    expect(data.purchasesByStatus).toEqual({ PENDING: 0, PAID: 0, FAILED: 0 });
    expect(data.catalogByType).toEqual({ MCQ: 0, PDF: 0, EDITOR: 0 });
    expect(data.attemptsByTypeOverTime).toHaveLength(30);
    expect(data.revenueOverTime).toHaveLength(30);
    expect(data.secondary).toEqual({
      entitlementsExpiringIn7Days: 0,
      resultsPending: 0,
      resultsPublished: 0,
      attemptsByNumber: { '1': 0, '2': 0, '3': 0 },
    });
  });

  it('aggregates seeded commerce, attempts, evaluations, and catalog', async () => {
    const app = createApp();
    const adminToken = await login(app, 'admin@example.com');
    const student = await userRepository.findByEmail('student@example.com');
    expect(student).toBeTruthy();

    const category = await CategoryModel.create({ name: 'Math', status: 'ACTIVE' });
    const moduleDoc = await ModuleModel.create({
      categoryId: category._id,
      name: 'Algebra',
      status: 'ACTIVE',
    });
    const mcq = await TestSeriesModel.create({
      moduleId: moduleDoc._id,
      title: 'MCQ Free',
      type: 'MCQ',
      duration: 60,
      access: { isFree: true, price: 0, currency: 'INR' },
      attemptPolicy: { maxAttempts: 3 },
      scoring: { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0, maxScore: 100 },
      status: 'ACTIVE',
    });
    const pdf = await TestSeriesModel.create({
      moduleId: moduleDoc._id,
      title: 'PDF Paid',
      type: 'PDF',
      duration: 120,
      access: { isFree: false, price: 49900, currency: 'INR' },
      attemptPolicy: { maxAttempts: 3 },
      scoring: { maxScore: 100 },
      status: 'ACTIVE',
    });

    await PurchaseModel.create([
      {
        studentId: student!._id,
        testSeriesId: pdf._id,
        amount: 49900,
        currency: 'INR',
        status: 'PAID',
      },
      {
        studentId: student!._id,
        testSeriesId: pdf._id,
        amount: 10000,
        currency: 'INR',
        status: 'PENDING',
      },
      {
        studentId: student!._id,
        testSeriesId: pdf._id,
        amount: 20000,
        currency: 'INR',
        status: 'FAILED',
      },
    ]);

    const expiresSoon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const pdfEntitlement = await EntitlementModel.create({
      studentId: student!._id,
      testSeriesId: pdf._id,
      status: 'ACTIVE',
      grantedAt: new Date(),
      expiresAt: expiresSoon,
    });

    const now = new Date();
    await AttemptModel.create([
      {
        studentId: student!._id,
        testSeriesId: mcq._id,
        entitlementId: new Types.ObjectId(),
        status: 'IN_PROGRESS',
        startedAt: now,
        examEndsAt: new Date(now.getTime() + 60 * 60 * 1000),
        attemptNumber: 1,
        configurationSnapshot: { duration: 60 },
      },
      {
        studentId: student!._id,
        testSeriesId: pdf._id,
        entitlementId: pdfEntitlement._id,
        status: 'SUBMITTED',
        startedAt: now,
        examEndsAt: new Date(now.getTime() + 60 * 60 * 1000),
        submittedAt: now,
        attemptNumber: 2,
        configurationSnapshot: { duration: 120 },
      },
    ]);

    const submission = await SubmissionModel.create({
      attemptId: new Types.ObjectId(),
      studentId: student!._id,
      testSeriesId: pdf._id,
      type: 'PDF',
      submittedAt: now,
    });
    await EvaluationModel.create([
      {
        submissionId: submission._id,
        mode: 'MANUAL',
        status: 'UNASSIGNED',
      },
    ]);
    // unique submissionId — second evaluation needs another submission
    const submission2 = await SubmissionModel.create({
      attemptId: new Types.ObjectId(),
      studentId: student!._id,
      testSeriesId: pdf._id,
      type: 'PDF',
      submittedAt: now,
    });
    await EvaluationModel.create({
      submissionId: submission2._id,
      mode: 'MANUAL',
      status: 'COMPLETED',
    });

    await ResultModel.create({
      attemptId: new Types.ObjectId(),
      studentId: student!._id,
      testSeriesId: pdf._id,
      submissionId: submission._id,
      evaluationId: new Types.ObjectId(),
      status: 'PENDING',
      score: 0,
      maxScore: 100,
      percentage: 0,
    });

    const response = await request(app).get('/admin/analytics/overview').set(bearer(adminToken));

    expect(response.status).toBe(200);
    const data = response.body.data;

    expect(data.kpis.activeStudents).toBe(1);
    expect(data.kpis.paidRevenuePaise).toBe(49900);
    expect(data.kpis.activeEntitlements).toBe(1);
    expect(data.kpis.attemptsInFlight).toBe(1);
    expect(data.kpis.evalBacklog).toBe(2);

    expect(data.purchasesByStatus).toEqual({ PENDING: 1, PAID: 1, FAILED: 1 });
    expect(data.catalogByType.MCQ).toBe(1);
    expect(data.catalogByType.PDF).toBe(1);
    expect(data.evaluationQueue.UNASSIGNED).toBe(1);
    expect(data.evaluationQueue.COMPLETED).toBe(1);
    expect(data.secondary.entitlementsExpiringIn7Days).toBe(1);
    expect(data.secondary.resultsPending).toBe(1);
    expect(data.secondary.attemptsByNumber).toEqual({ '1': 1, '2': 1, '3': 0 });

    const today = now.toISOString().slice(0, 10);
    const attemptBucket = data.attemptsByTypeOverTime.find(
      (row: { bucket: string }) => row.bucket === today,
    );
    expect(attemptBucket).toMatchObject({ MCQ: 1, PDF: 1, EDITOR: 0 });

    const revenueBucket = data.revenueOverTime.find(
      (row: { bucket: string }) => row.bucket === today,
    );
    expect(revenueBucket.amountPaise).toBe(49900);
  });
});
