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
import { ModuleModel } from '../src/database/models/module.model';
import { QuestionModel } from '../src/database/models/question.model';
import { ResultModel } from '../src/database/models/result.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../src/database/models/conventions';
import { hashPassword } from '../src/modules/auth/password';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const PRICE_PAISE = 49900;
const mcqScoring = { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 };
const missingId = new Types.ObjectId().toString();

type App = ReturnType<typeof createApp>;

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

describe('Phase 8 Attempt Engine', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await ModuleModel.createIndexes();
    await TestSeriesModel.createIndexes();
    await QuestionModel.createIndexes();
    await EntitlementModel.createIndexes();
    await AttemptModel.createIndexes();
    await SubmissionModel.createIndexes();
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
    vi.useRealTimers();
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: TEST_SECRET,
      JWT_ACCESS_TOKEN_TTL: '2h',
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
      editorQuestion: editorQuestion.body.data as { id: string },
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

  describe('start attempt', () => {
    it('allows free MCQ and paid EDITOR students to start', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.editor.id);

      const mcqStart = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(mcqStart.status).toBe(201);
      expect(mcqStart.body.data.attemptNumber).toBe(1);
      expect(mcqStart.body.data.status).toBe('IN_PROGRESS');
      expect(mcqStart.body.data.questions).toHaveLength(1);
      expect(mcqStart.body.data.questions[0].content.correctOptionId).toBeUndefined();
      expect(mcqStart.body.data.configuration.duration).toBe(3600);
      expect(mcqStart.body.data.configuration.scoring.maxScore).toBe(100);
      expect(mcqStart.body.data.remainingSeconds).toBeGreaterThan(0);

      const editorStart = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(editorStart.status).toBe(201);
      expect(editorStart.body.data.attemptNumber).toBe(1);
      expect(editorStart.body.data.configuration.scoring.maxScore).toBe(100);
    });

    it('snapshots maxScore and ignores later Test Series changes', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.pdf.id);

      const configured = await request(app)
        .patch(`/admin/test-series/${catalog.pdf.id}`)
        .set(bearer(catalog.adminToken))
        .send({ scoring: { maxScore: 50 } });
      expect(configured.status).toBe(200);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.status).toBe(201);
      expect(started.body.data.configuration.scoring.maxScore).toBe(50);

      const stored = await AttemptModel.findById(started.body.data.id);
      expect(stored!.configurationSnapshot.scoring.maxScore).toBe(50);

      await request(app)
        .patch(`/admin/test-series/${catalog.pdf.id}`)
        .set(bearer(catalog.adminToken))
        .send({ scoring: { maxScore: 120 } });

      const resumed = await request(app)
        .get(`/me/attempts/${started.body.data.id}`)
        .set(bearer(studentToken));
      expect(resumed.body.data.configuration.scoring.maxScore).toBe(50);
      const unchanged = await AttemptModel.findById(started.body.data.id);
      expect(unchanged!.configurationSnapshot.scoring.maxScore).toBe(50);
    });

    it('rejects unauthenticated, evaluator, and admin', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const adminToken = await login(app, 'admin@example.com');

      const unauth = await request(app).post('/attempts').send({ testSeriesId: catalog.mcq.id });
      expect(unauth.status).toBe(401);

      const evaluator = await request(app)
        .post('/attempts')
        .set(bearer(evaluatorToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(evaluator.status).toBe(403);

      const admin = await request(app)
        .post('/attempts')
        .set(bearer(adminToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(admin.status).toBe(403);
    });

    it('enforces not found, soft-delete, availability, entitlement, and content gates', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');

      const missing = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: missingId });
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe(ErrorCodes.TEST_SERIES_NOT_FOUND);

      await TestSeriesModel.findByIdAndUpdate(catalog.mcq.id, { deletedAt: new Date() });
      const deleted = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(deleted.status).toBe(404);

      await TestSeriesModel.findByIdAndUpdate(catalog.mcq.id, { deletedAt: null });
      await TestSeriesModel.findByIdAndUpdate(catalog.editor.id, {
        'availability.startsAt': addDays(new Date(), 1),
        'availability.endsAt': addDays(new Date(), 2),
      });
      await grantPaidEntitlement(studentId, catalog.editor.id);
      const unavailable = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(unavailable.status).toBe(409);
      expect(unavailable.body.error.code).toBe(ErrorCodes.TEST_SERIES_UNAVAILABLE);

      const noEntitlement = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(noEntitlement.status).toBe(403);
      expect(noEntitlement.body.error.code).toBe(ErrorCodes.ENTITLEMENT_REQUIRED);

      await grantPaidEntitlement(studentId, catalog.pdf.id, addDays(new Date(), -1));
      const expired = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(expired.status).toBe(403);
      expect(expired.body.error.code).toBe(ErrorCodes.ENTITLEMENT_EXPIRED);

      await QuestionModel.updateMany({ testSeriesId: catalog.mcq.id }, { status: 'INACTIVE' });
      const noContent = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(noContent.status).toBe(409);
      expect(noContent.body.error.code).toBe(ErrorCodes.ATTEMPT_CONTENT_INVALID);
    });

    it('rejects client-controlled timing fields', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const response = await request(app).post('/attempts').set(bearer(studentToken)).send({
        testSeriesId: catalog.mcq.id,
        startedAt: '2020-01-01T00:00:00.000Z',
        examEndsAt: '2099-01-01T00:00:00.000Z',
        uploadEndsAt: '2099-01-01T00:00:00.000Z',
        duration: 10,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });
  });

  describe('attempt numbering and limit', () => {
    it('allows unlimited free MCQ attempts beyond 3', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      for (let number = 1; number <= 4; number += 1) {
        const started = await request(app)
          .post('/attempts')
          .set(bearer(studentToken))
          .send({ testSeriesId: catalog.mcq.id });
        expect(started.status).toBe(201);
        expect(started.body.data.attemptNumber).toBe(number);

        const submitted = await request(app)
          .post(`/attempts/${started.body.data.id}/submit`)
          .set(bearer(studentToken));
        expect(submitted.status).toBe(200);
      }

      const count = await AttemptModel.countDocuments({});
      expect(count).toBe(4);
    });

    it('allows paid attempts 1–3 and rejects the fourth', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.editor.id);

      for (let number = 1; number <= 3; number += 1) {
        const started = await request(app)
          .post('/attempts')
          .set(bearer(studentToken))
          .send({ testSeriesId: catalog.editor.id });
        expect(started.status).toBe(201);
        expect(started.body.data.attemptNumber).toBe(number);

        const submitted = await request(app)
          .post(`/attempts/${started.body.data.id}/submit`)
          .set(bearer(studentToken));
        expect(submitted.status).toBe(200);
      }

      const fourth = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(fourth.status).toBe(409);
      expect(fourth.body.error.code).toBe(ErrorCodes.ATTEMPT_LIMIT_EXCEEDED);

      const count = await AttemptModel.countDocuments({ testSeriesId: catalog.editor.id });
      expect(count).toBe(3);
    });

    it('grants a fresh set of attempts on repurchase after the entitlement expires', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      const first = await grantPaidEntitlement(studentId, catalog.editor.id);

      for (let number = 1; number <= 3; number += 1) {
        const started = await request(app)
          .post('/attempts')
          .set(bearer(studentToken))
          .send({ testSeriesId: catalog.editor.id });
        expect(started.status).toBe(201);
        expect(started.body.data.attemptNumber).toBe(number);

        const submitted = await request(app)
          .post(`/attempts/${started.body.data.id}/submit`)
          .set(bearer(studentToken));
        expect(submitted.status).toBe(200);
      }

      const exhausted = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(exhausted.status).toBe(409);
      expect(exhausted.body.error.code).toBe(ErrorCodes.ATTEMPT_LIMIT_EXCEEDED);

      await EntitlementModel.findByIdAndUpdate(first._id, {
        status: 'EXPIRED',
        expiresAt: addDays(new Date(), -1),
      });
      const repurchased = await grantPaidEntitlement(studentId, catalog.editor.id);

      const fresh = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(fresh.status).toBe(201);
      expect(fresh.body.data.attemptNumber).toBe(1);

      const stored = await AttemptModel.findById(fresh.body.data.id);
      expect(stored!.entitlementId.toString()).toBe(repurchased._id.toString());
      expect(await AttemptModel.countDocuments({ entitlementId: first._id })).toBe(3);
    });

    it('does not reset numbering on resume', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const first = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(first.body.data.attemptNumber).toBe(1);

      await request(app).post(`/attempts/${first.body.data.id}/submit`).set(bearer(studentToken));

      const second = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(second.body.data.attemptNumber).toBe(2);

      const resumed = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(resumed.body.data.id).toBe(second.body.data.id);
      expect(resumed.body.data.attemptNumber).toBe(2);
    });

    it('prevents duplicate attempt numbers under concurrent starts', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .post('/attempts')
            .set(bearer(studentToken))
            .send({ testSeriesId: catalog.mcq.id }),
        ),
      );

      const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.data.id));
      expect(ids.size).toBe(1);
      expect(await AttemptModel.countDocuments({})).toBe(1);
    });
  });

  describe('list attempts', () => {
    it('returns batched testSeries title and type on each list item', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.editor.id);

      const mcqStart = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(mcqStart.status).toBe(201);

      const editorStart = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      expect(editorStart.status).toBe(201);

      const listed = await request(app).get('/me/attempts').set(bearer(studentToken));
      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(2);

      const bySeriesId = new Map(
        listed.body.data.map((row: { testSeriesId: string }) => [row.testSeriesId, row]),
      );

      expect(bySeriesId.get(catalog.mcq.id)).toMatchObject({
        testSeriesId: catalog.mcq.id,
        testSeries: {
          id: catalog.mcq.id,
          title: 'MCQ Series',
          type: 'MCQ',
          moduleName: 'Algebra',
          categoryName: 'Mathematics',
        },
      });
      expect(bySeriesId.get(catalog.editor.id)).toMatchObject({
        testSeriesId: catalog.editor.id,
        testSeries: {
          id: catalog.editor.id,
          title: 'Editor Series',
          type: 'EDITOR',
          moduleName: 'Algebra',
          categoryName: 'Mathematics',
        },
      });
    });
  });

  describe('timer and resume', () => {
    it('uses server timing and does not reset on resume', async () => {
      const startedAt = new Date('2026-08-14T10:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(startedAt);

      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(started.status).toBe(201);
      expect(started.body.data.startedAt).toBe(startedAt.toISOString());
      expect(started.body.data.examEndsAt).toBe('2026-08-14T11:00:00.000Z');
      expect(started.body.data.remainingSeconds).toBe(3600);
      expect(started.body.data.configuration.duration).toBe(3600);

      vi.setSystemTime(new Date('2026-08-14T10:15:00.000Z'));

      const resumed = await request(app)
        .get(`/me/attempts/${started.body.data.id}`)
        .set(bearer(studentToken));
      expect(resumed.status).toBe(200);
      expect(resumed.body.data.id).toBe(started.body.data.id);
      expect(resumed.body.data.startedAt).toBe(startedAt.toISOString());
      expect(resumed.body.data.examEndsAt).toBe('2026-08-14T11:00:00.000Z');
      expect(resumed.body.data.remainingSeconds).toBe(2700);

      const active = await request(app)
        .get('/me/attempts/active')
        .query({ testSeriesId: catalog.mcq.id })
        .set(bearer(studentToken));
      expect(active.status).toBe(200);
      expect(active.body.data.id).toBe(started.body.data.id);
    });

    it('returns the active attempt during MCQ final-submit grace', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'));

      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(started.status).toBe(201);
      expect(started.body.data.recovered).toBe(false);

      vi.setSystemTime(new Date('2026-08-14T11:01:00.000Z'));

      const active = await request(app)
        .get('/me/attempts/active')
        .query({ testSeriesId: catalog.mcq.id })
        .set(bearer(studentToken));
      expect(active.status).toBe(200);
      expect(active.body.data.id).toBe(started.body.data.id);
      expect(active.body.data.status).toBe('IN_PROGRESS');

      const resumed = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(resumed.status).toBe(201);
      expect(resumed.body.data.id).toBe(started.body.data.id);
      expect(resumed.body.data.recovered).toBe(true);
    });

    it('rejects progress after examEndsAt and auto-submits MCQ only after the 2-minute grace', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'));

      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(started.status).toBe(201);

      const saved = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });
      expect(saved.status).toBe(200);

      vi.setSystemTime(new Date('2026-08-14T11:00:00.000Z'));

      const lateSave = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(lateSave.status).toBe(409);
      expect(lateSave.body.error.code).toBe(ErrorCodes.ATTEMPT_EXPIRED);

      const duringGrace = await request(app)
        .get(`/me/attempts/${started.body.data.id}`)
        .set(bearer(studentToken));
      expect(duringGrace.status).toBe(200);
      expect(duringGrace.body.data.status).toBe('IN_PROGRESS');
      expect(duringGrace.body.data.answers[0].selectedOptionId).toBe('B');

      vi.setSystemTime(new Date('2026-08-14T11:02:00.001Z'));

      const retrieved = await request(app)
        .get(`/me/attempts/${started.body.data.id}`)
        .set(bearer(studentToken));
      expect(retrieved.status).toBe(200);
      expect(retrieved.body.data.status).toBe('SUBMITTED');
      expect(retrieved.body.data.answers[0].selectedOptionId).toBe('B');

      expect(await EvaluationModel.countDocuments({})).toBe(1);
      expect(await ResultModel.countDocuments({})).toBe(1);
    });
  });

  describe('MCQ progress', () => {
    it('persists selectedOptionId and never returns correctOptionId', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });

      const saved = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(saved.status).toBe(200);
      expect(saved.body.data.version).toBe(2);
      expect(saved.body.data.answers[0].selectedOptionId).toBe('A');
      expect(JSON.stringify(saved.body.data)).not.toContain('correctOptionId');

      const invalidQuestion = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          answers: [{ questionId: missingId, selectedOptionId: 'A' }],
        });
      expect(invalidQuestion.status).toBe(400);

      const invalidOption = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'Z' }],
        });
      expect(invalidOption.status).toBe(400);

      const withKey = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          answers: [
            {
              questionId: catalog.mcqQuestion.id,
              selectedOptionId: 'B',
              correctOptionId: 'B',
            },
          ],
        });
      expect(withKey.status).toBe(400);
    });
  });

  describe('EDITOR progress and autosave', () => {
    it('persists editorDocument without submitting or creating a new attempt', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');
      await grantPaidEntitlement(studentId, catalog.editor.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });

      const doc = { type: 'doc', content: [{ type: 'paragraph', text: 'draft answer' }] };
      const saved = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: doc });
      expect(saved.status).toBe(200);
      expect(saved.body.data.status).toBe('IN_PROGRESS');
      expect(saved.body.data.editorDocument).toEqual(doc);
      expect(await AttemptModel.countDocuments({})).toBe(1);

      const resumed = await request(app)
        .get(`/me/attempts/${started.body.data.id}`)
        .set(bearer(studentToken));
      expect(resumed.body.data.editorDocument).toEqual(doc);

      const withCode = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({ version: 2, editorDocument: { type: 'doc', code: 'print(1)' } });
      expect(withCode.status).toBe(400);
    });
  });

  describe('submission', () => {
    it('submits MCQ, freezes writes, and creates no Evaluation/Result', async () => {
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
      expect(submitted.body.data.submissionId).toBeTruthy();

      const repeat = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(repeat.status).toBe(200);
      expect(repeat.body.data.submissionId).toBe(submitted.body.data.submissionId);

      const afterSubmit = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(afterSubmit.status).toBe(409);
      expect(afterSubmit.body.error.code).toBe(ErrorCodes.ATTEMPT_ALREADY_SUBMITTED);

      expect(await EvaluationModel.countDocuments({})).toBe(1);
      expect(await ResultModel.countDocuments({})).toBe(1);
      expect(await SubmissionModel.countDocuments({})).toBe(1);
    });
  });

  describe('concurrency and security', () => {
    it('rejects stale version writes', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });

      const first = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(first.status).toBe(200);

      const stale = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe(ErrorCodes.STALE_ATTEMPT_VERSION);
    });

    it('enforces ownership and rejects Mongo operators / protected fields', async () => {
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const otherToken = await login(app, 'student2@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });

      const other = await request(app)
        .get(`/me/attempts/${started.body.data.id}`)
        .set(bearer(otherToken));
      expect(other.status).toBe(404);

      const otherWrite = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(otherToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(otherWrite.status).toBe(404);

      const operators = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          $set: { status: 'SUBMITTED' },
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(operators.status).toBe(400);

      const protectedFields = await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          examEndsAt: '2099-01-01T00:00:00.000Z',
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(protectedFields.status).toBe(400);
    });
  });
});
