import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
import { AuditLogModel } from '../src/database/models/audit-log.model';
import { CategoryModel } from '../src/database/models/category.model';
import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../src/database/models/conventions';
import { ATTEMPT_STATUSES } from '../src/database/models/enums';
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

describe('Phase 25 MCQ/EDITOR server-only submission grace', () => {
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
    await ResultModel.createIndexes();
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

  function freezeAtExamStart() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
  }

  describe('MCQ', () => {
    it('allows answer mutation before examEndsAt and rejects at/after the deadline', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(started.status).toBe(201);
      const attemptId = started.body.data.id as string;

      vi.setSystemTime(new Date('2026-08-20T10:59:59.999Z'));
      const before = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });
      expect(before.status).toBe(200);
      expect(before.body.data.status).toBe('IN_PROGRESS');

      vi.setSystemTime(new Date('2026-08-20T11:00:00.000Z'));
      const atDeadline = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(atDeadline.status).toBe(409);
      expect(atDeadline.body.error.code).toBe(ErrorCodes.ATTEMPT_EXPIRED);

      vi.setSystemTime(new Date('2026-08-20T11:01:00.000Z'));
      const duringGrace = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      expect(duringGrace.status).toBe(409);
      expect(duringGrace.body.error.code).toBe(ErrorCodes.ATTEMPT_EXPIRED);

      const persisted = await AttemptModel.findById(attemptId);
      expect(persisted!.status).toBe('IN_PROGRESS');
      expect(persisted!.answers[0].selectedOptionIds).toEqual(['B']);
    });

    it('accepts final submit at examEndsAt, during grace, and at the grace boundary', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const first = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      await request(app)
        .patch(`/attempts/${first.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });

      vi.setSystemTime(new Date('2026-08-20T11:00:00.000Z'));
      const atDeadline = await request(app)
        .post(`/attempts/${first.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(atDeadline.status).toBe(200);
      expect(atDeadline.body.data.status).toBe('SUBMITTED');

      vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
      const second = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      await request(app)
        .patch(`/attempts/${second.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
        });
      vi.setSystemTime(new Date('2026-08-20T11:01:00.000Z'));
      const duringGrace = await request(app)
        .post(`/attempts/${second.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(duringGrace.status).toBe(200);
      expect(duringGrace.body.data.status).toBe('SUBMITTED');

      vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
      const third = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      await request(app)
        .patch(`/attempts/${third.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'C' }],
        });
      vi.setSystemTime(new Date('2026-08-20T11:02:00.000Z'));
      const atBoundary = await request(app)
        .post(`/attempts/${third.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(atBoundary.status).toBe(200);
      expect(atBoundary.body.data.status).toBe('SUBMITTED');
    });

    it('rejects final submit after grace and does not auto-submit until then', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      const attemptId = started.body.data.id as string;
      await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });

      vi.setSystemTime(new Date('2026-08-20T11:02:00.000Z'));
      const stillOpen = await request(app)
        .get(`/me/attempts/${attemptId}`)
        .set(bearer(studentToken));
      expect(stillOpen.body.data.status).toBe('IN_PROGRESS');
      expect(await SubmissionModel.countDocuments({})).toBe(0);

      vi.setSystemTime(new Date('2026-08-20T11:02:00.001Z'));
      const lateSubmit = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(lateSubmit.status).toBe(409);
      expect(lateSubmit.body.error.code).toBe(ErrorCodes.ATTEMPT_EXPIRED);

      const after = await request(app).get(`/me/attempts/${attemptId}`).set(bearer(studentToken));
      expect(after.body.data.status).toBe('SUBMITTED');
      expect(after.body.data.answers[0].selectedOptionId).toBe('B');
      expect(await SubmissionModel.countDocuments({})).toBe(1);
    });

    it('does not let submit during grace introduce new MCQ answers', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      const attemptId = started.body.data.id as string;
      await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });

      vi.setSystemTime(new Date('2026-08-20T11:01:00.000Z'));
      const submitted = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken))
        .send({
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'A' }],
          examEndsAt: '2099-01-01T00:00:00.000Z',
          submissionGraceSeconds: 3600,
        });
      expect(submitted.status).toBe(200);

      const submission = await SubmissionModel.findOne({ attemptId });
      expect(submission!.answers[0].selectedOptionId).toBe('B');
    });
  });

  describe('EDITOR', () => {
    it('allows editor mutation before examEndsAt and rejects at/after the deadline', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.editor.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      const attemptId = started.body.data.id as string;
      const doc = { type: 'doc', content: [{ type: 'paragraph', text: 'draft' }] };

      vi.setSystemTime(new Date('2026-08-20T10:59:59.999Z'));
      const before = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: doc });
      expect(before.status).toBe(200);

      vi.setSystemTime(new Date('2026-08-20T11:00:00.000Z'));
      const atDeadline = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          editorDocument: { type: 'doc', content: [{ type: 'paragraph', text: 'late' }] },
        });
      expect(atDeadline.status).toBe(409);
      expect(atDeadline.body.error.code).toBe(ErrorCodes.ATTEMPT_EXPIRED);

      vi.setSystemTime(new Date('2026-08-20T11:01:00.000Z'));
      const duringGrace = await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 2,
          editorDocument: { type: 'doc', content: [{ type: 'paragraph', text: 'late' }] },
        });
      expect(duringGrace.status).toBe(409);

      const persisted = await AttemptModel.findById(attemptId);
      expect(persisted!.status).toBe('IN_PROGRESS');
      expect(persisted!.editorDocument).toEqual(doc);
    });

    it('finalizes the last persisted editorDocument through grace and auto-submits after', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.editor.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      const attemptId = started.body.data.id as string;
      const doc = { type: 'doc', content: [{ type: 'paragraph', text: 'kept' }] };
      await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: doc });

      vi.setSystemTime(new Date('2026-08-20T11:01:00.000Z'));
      const duringGrace = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken))
        .send({
          editorDocument: { type: 'doc', content: [{ type: 'paragraph', text: 'injected' }] },
        });
      expect(duringGrace.status).toBe(200);
      const submission = await SubmissionModel.findOne({ attemptId });
      expect(submission!.editorDocument).toEqual(doc);

      vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
      const second = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      const secondDoc = { type: 'doc', content: [{ type: 'paragraph', text: 'second' }] };
      await request(app)
        .patch(`/attempts/${second.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: secondDoc });

      vi.setSystemTime(new Date('2026-08-20T11:02:00.000Z'));
      const atBoundary = await request(app)
        .post(`/attempts/${second.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(atBoundary.status).toBe(200);

      vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
      const third = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      const thirdDoc = { type: 'doc', content: [{ type: 'paragraph', text: 'auto' }] };
      await request(app)
        .patch(`/attempts/${third.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: thirdDoc });

      vi.setSystemTime(new Date('2026-08-20T11:02:00.000Z'));
      const stillOpen = await request(app)
        .get(`/me/attempts/${third.body.data.id}`)
        .set(bearer(studentToken));
      expect(stillOpen.body.data.status).toBe('IN_PROGRESS');

      vi.setSystemTime(new Date('2026-08-20T11:02:00.001Z'));
      const lateSubmit = await request(app)
        .post(`/attempts/${third.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(lateSubmit.status).toBe(409);
      expect(lateSubmit.body.error.code).toBe(ErrorCodes.ATTEMPT_EXPIRED);

      const auto = await request(app)
        .get(`/me/attempts/${third.body.data.id}`)
        .set(bearer(studentToken));
      expect(auto.body.data.status).toBe('SUBMITTED');
      expect(auto.body.data.editorDocument).toEqual(thirdDoc);
      const autoSubmission = await SubmissionModel.findOne({ attemptId: third.body.data.id });
      expect(autoSubmission!.editorDocument).toEqual(thirdDoc);
    });
  });

  describe('security and lifecycle', () => {
    it('ignores client examEndsAt, grace, and submissionEndsAt fields', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');

      const started = await request(app).post('/attempts').set(bearer(studentToken)).send({
        testSeriesId: catalog.mcq.id,
        examEndsAt: '2099-01-01T00:00:00.000Z',
        submissionEndsAt: '2099-01-01T00:02:00.000Z',
        submissionGraceSeconds: 3600,
        graceSeconds: 3600,
      });
      expect(started.status).toBe(400);

      const created = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(created.status).toBe(201);
      expect(created.body.data.examEndsAt).toBe('2026-08-20T11:00:00.000Z');
      expect(created.body.data.uploadEndsAt).toBeNull();
      expect(created.body.data.configuration.submissionGraceSeconds).toBeNull();
      expect(created.body.data.remainingSeconds).toBe(3600);

      const persisted = await AttemptModel.findById(created.body.data.id);
      expect(persisted!.examEndsAt.toISOString()).toBe('2026-08-20T11:00:00.000Z');
      expect(persisted!.configurationSnapshot.submissionGraceSeconds).toBeNull();
    });

    it('does not terminate a running Attempt when entitlement expires', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const entitlement = await grantPaidEntitlement(
        await studentIdFor('student@example.com'),
        catalog.editor.id,
      );

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.editor.id });
      const attemptId = started.body.data.id as string;
      const examEndsAt = started.body.data.examEndsAt as string;
      const doc = { type: 'doc', content: [{ type: 'paragraph', text: 'kept' }] };
      await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: doc });

      await EntitlementModel.findByIdAndUpdate(entitlement._id, {
        expiresAt: new Date('2026-08-20T10:10:00.000Z'),
        status: 'EXPIRED',
      });

      vi.setSystemTime(new Date('2026-08-20T11:01:00.000Z'));
      const retrieved = await request(app)
        .get(`/me/attempts/${attemptId}`)
        .set(bearer(studentToken));
      expect(retrieved.body.data.status).toBe('IN_PROGRESS');
      expect(retrieved.body.data.examEndsAt).toBe(examEndsAt);

      const submitted = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');
    });

    it('lets a disabled student finish an owned running Attempt during grace and blocks a new start', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      const studentId = await studentIdFor('student@example.com');

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      const attemptId = started.body.data.id as string;
      await request(app)
        .patch(`/attempts/${attemptId}/answers`)
        .set(bearer(studentToken))
        .send({
          version: 1,
          answers: [{ questionId: catalog.mcqQuestion.id, selectedOptionId: 'B' }],
        });

      const disabled = await request(app)
        .patch(`/admin/users/${studentId}`)
        .set(bearer(catalog.adminToken))
        .send({ status: 'DISABLED' });
      expect(disabled.status).toBe(200);

      vi.setSystemTime(new Date('2026-08-20T11:01:00.000Z'));
      const current = await request(app).get(`/me/attempts/${attemptId}`).set(bearer(studentToken));
      expect(current.status).toBe(200);
      expect(current.body.data.status).toBe('IN_PROGRESS');

      const submitted = await request(app)
        .post(`/attempts/${attemptId}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');

      vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
      const startAgain = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.mcq.id });
      expect(startAgain.status).toBe(403);
      expect(startAgain.body.error.code).toBe(ErrorCodes.ACCOUNT_DISABLED);
      expect(await AttemptModel.countDocuments({})).toBe(1);
    });

    it('keeps PDF on the 5-minute uploadEndsAt path and does not add a new Attempt status', async () => {
      freezeAtExamStart();
      const app = createApp();
      const catalog = await seedCatalog(app);
      const studentToken = await login(app, 'student@example.com');
      await grantPaidEntitlement(await studentIdFor('student@example.com'), catalog.pdf.id);

      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId: catalog.pdf.id });
      expect(started.body.data.uploadEndsAt).toBe('2026-08-20T11:05:00.000Z');
      expect(started.body.data.examEndsAt).toBe('2026-08-20T11:00:00.000Z');

      vi.setSystemTime(new Date('2026-08-20T11:02:00.000Z'));
      const pending = await request(app)
        .get(`/me/attempts/${started.body.data.id}`)
        .set(bearer(studentToken));
      expect(pending.body.data.status).toBe('UPLOAD_PENDING');
      expect(pending.body.data.uploadEndsAt).toBe('2026-08-20T11:05:00.000Z');

      vi.setSystemTime(new Date('2026-08-20T11:05:00.001Z'));
      const expired = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(expired.status).toBe(409);
      expect(expired.body.error.code).toBe(ErrorCodes.FILE_UPLOAD_EXPIRED);

      const persisted = await AttemptModel.findById(started.body.data.id);
      expect(persisted!.status).toBe('EXPIRED');
      expect([...ATTEMPT_STATUSES]).toEqual([
        'IN_PROGRESS',
        'UPLOAD_PENDING',
        'SUBMITTED',
        'EXPIRED',
        'CANCELLED',
      ]);
      expect(ATTEMPT_STATUSES).not.toContain('GRACE_PERIOD');
      expect(ATTEMPT_STATUSES).not.toContain('SUBMISSION_GRACE');
    });
  });
});
