import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { CategoryModel } from '../src/database/models/category.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { EvaluationRevisionModel } from '../src/database/models/evaluation-revision.model';
import { EvaluatorCategoryAssignmentModel } from '../src/database/models/evaluator-category-assignment.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword } from '../src/modules/auth/password';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const SUMMARY_PATH = '/evaluator/evaluations/summary';

type App = ReturnType<typeof createApp>;

function bearer(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-exam-session-id': '11111111-1111-4111-8111-111111111111',
  };
}

async function seedUsers(): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD);
  await userRepository.create({
    email: 'student@example.com',
    passwordHash,
    role: 'STUDENT',
    status: 'ACTIVE',
    name: { first: 'Stu', last: 'Dent' },
  });
  await userRepository.create({
    email: 'admin@example.com',
    passwordHash,
    role: 'ADMIN',
    status: 'ACTIVE',
    name: { first: 'Ada', last: 'Min' },
  });
  await userRepository.create({
    email: 'evaluator@example.com',
    passwordHash,
    role: 'EVALUATOR',
    status: 'ACTIVE',
    name: { first: 'Eva', last: 'Luator' },
  });
  await userRepository.create({
    email: 'other-evaluator@example.com',
    passwordHash,
    role: 'EVALUATOR',
    status: 'ACTIVE',
    name: { first: 'Otto', last: 'Ther' },
  });
}

async function login(app: App, email: string): Promise<string> {
  const response = await request(app).post('/auth/login').send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.body.data.accessToken as string;
}

async function seedEvaluation(
  evaluatorId: Types.ObjectId,
  status: string,
  studentId: Types.ObjectId,
) {
  const submission = await SubmissionModel.create({
    attemptId: new Types.ObjectId(),
    studentId,
    testSeriesId: new Types.ObjectId(),
    type: 'PDF',
    submittedAt: new Date(),
  });

  return EvaluationModel.create({
    submissionId: submission._id,
    mode: 'MANUAL',
    status,
    evaluatorId,
  });
}

describe('Evaluator summary', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await SubmissionModel.createIndexes();
    await EvaluationModel.createIndexes();
    await EvaluationRevisionModel.createIndexes();
    await EvaluatorCategoryAssignmentModel.createIndexes();
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

  it('rejects unauthenticated access', async () => {
    const app = createApp();

    const response = await request(app).get(SUMMARY_PATH);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(ErrorCodes.AUTHENTICATION_REQUIRED);
  });

  it('rejects non-evaluator roles', async () => {
    const app = createApp();
    const studentToken = await login(app, 'student@example.com');
    const adminToken = await login(app, 'admin@example.com');

    const student = await request(app).get(SUMMARY_PATH).set(bearer(studentToken));
    expect(student.status).toBe(403);

    const admin = await request(app).get(SUMMARY_PATH).set(bearer(adminToken));
    expect(admin.status).toBe(403);
  });

  it('returns a fully zero-filled shape when the evaluator has nothing assigned', async () => {
    const app = createApp();
    const token = await login(app, 'evaluator@example.com');

    const response = await request(app).get(SUMMARY_PATH).set(bearer(token));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const data = response.body.data;
    expect(data.totalAssigned).toBe(0);
    expect(data.statusCounts).toEqual({
      UNASSIGNED: 0,
      ASSIGNED: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      FINALIZED: 0,
    });
    expect(data.categories).toEqual([]);
    expect(data.completionTrend.windowDays).toBe(30);
    expect(data.completionTrend.totalCompleted).toBe(0);
    expect(data.completionTrend.buckets).toHaveLength(30);
    expect(data.completionTrend.buckets.every((row: { count: number }) => row.count === 0)).toBe(
      true,
    );
  });

  it('counts only the requesting evaluator across the full collection', async () => {
    const app = createApp();
    const token = await login(app, 'evaluator@example.com');
    const evaluator = await userRepository.findByEmail('evaluator@example.com');
    const other = await userRepository.findByEmail('other-evaluator@example.com');
    const student = await userRepository.findByEmail('student@example.com');

    // More than one page worth of evaluations, to prove counts are not page-bounded.
    for (let i = 0; i < 25; i += 1) {
      await seedEvaluation(evaluator!._id, 'ASSIGNED', student!._id);
    }
    await seedEvaluation(evaluator!._id, 'IN_PROGRESS', student!._id);
    await seedEvaluation(evaluator!._id, 'COMPLETED', student!._id);
    await seedEvaluation(evaluator!._id, 'FINALIZED', student!._id);
    await seedEvaluation(other!._id, 'ASSIGNED', student!._id);

    const response = await request(app).get(SUMMARY_PATH).set(bearer(token));

    expect(response.status).toBe(200);
    expect(response.body.data.totalAssigned).toBe(28);
    expect(response.body.data.statusCounts).toEqual({
      UNASSIGNED: 0,
      ASSIGNED: 25,
      IN_PROGRESS: 1,
      COMPLETED: 1,
      FINALIZED: 1,
    });
  });

  it('reports active category assignments and the completion trend', async () => {
    const app = createApp();
    const token = await login(app, 'evaluator@example.com');
    const evaluator = await userRepository.findByEmail('evaluator@example.com');

    const active = await CategoryModel.create({ name: 'Math', status: 'ACTIVE' });
    const inactive = await CategoryModel.create({ name: 'Science', status: 'ACTIVE' });
    await EvaluatorCategoryAssignmentModel.create([
      { evaluatorId: evaluator!._id, categoryId: active._id, isActive: true },
      { evaluatorId: evaluator!._id, categoryId: inactive._id, isActive: false },
    ]);

    const now = new Date();
    const longAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    await EvaluationRevisionModel.create([
      {
        evaluationId: new Types.ObjectId(),
        revisionNumber: 1,
        status: 'COMPLETED',
        evaluatorId: evaluator!._id,
        completedAt: now,
      },
      {
        evaluationId: new Types.ObjectId(),
        revisionNumber: 1,
        status: 'COMPLETED',
        evaluatorId: evaluator!._id,
        completedAt: now,
      },
      {
        evaluationId: new Types.ObjectId(),
        revisionNumber: 1,
        status: 'FINALIZED',
        evaluatorId: evaluator!._id,
        completedAt: longAgo,
      },
    ]);

    const response = await request(app).get(SUMMARY_PATH).set(bearer(token));

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.categories).toEqual([
      { categoryId: active._id.toString(), name: 'Math', status: 'ACTIVE' },
    ]);
    expect(data.completionTrend.totalCompleted).toBe(2);
    const todayBucket = data.completionTrend.buckets.find(
      (row: { bucket: string }) => row.bucket === now.toISOString().slice(0, 10),
    );
    expect(todayBucket.count).toBe(2);
  });
});
