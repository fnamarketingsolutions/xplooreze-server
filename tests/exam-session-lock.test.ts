import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
import { CategoryModel } from '../src/database/models/category.model';
import { EXAM_SESSION_LOCK_TTL_MS } from '../src/database/models/conventions';
import { ModuleModel } from '../src/database/models/module.model';
import { QuestionModel } from '../src/database/models/question.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword } from '../src/modules/auth/password';
import { EXAM_SESSION_HEADER } from '../src/modules/attempts/exam-session';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const DEFAULT_SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

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

function bearer(token: string, sessionId = DEFAULT_SESSION) {
  return {
    Authorization: `Bearer ${token}`,
    [EXAM_SESSION_HEADER]: sessionId,
  };
}

describe('Exam session lock', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await ModuleModel.createIndexes();
    await TestSeriesModel.createIndexes();
    await QuestionModel.createIndexes();
    await AttemptModel.createIndexes();
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

  async function seedMcqAndStart(app: App) {
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
      scoring: { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 },
    });
    expect(mcq.status).toBe(201);

    const question = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
      testSeriesId: mcq.body.data.id,
      position: 1,
      questionText: 'What is 2 + 2?',
      content: {
        options: [
          { id: 'A', text: '3' },
          { id: 'B', text: '4' },
        ],
        correctOptionId: 'B',
      },
    });
    expect(question.status).toBe(201);

    const studentToken = await login(app, 'student@example.com');
    const started = await request(app)
      .post('/attempts')
      .set(bearer(studentToken))
      .send({ testSeriesId: mcq.body.data.id });
    expect(started.status).toBe(201);

    return {
      studentToken,
      attemptId: started.body.data.id as string,
      questionId: question.body.data.id as string,
      version: started.body.data.version as number,
    };
  }

  it('claims a session successfully', async () => {
    const app = createApp();
    const { studentToken, attemptId } = await seedMcqAndStart(app);
    const sessionId = randomUUID();

    const claimed = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, sessionId))
      .send({ sessionId });

    expect(claimed.status).toBe(200);
    expect(claimed.body.data.sessionId).toBe(sessionId);
    expect(claimed.body.data.locked).toBe(true);
    expect(claimed.body.data.expiresAt).toBeTruthy();

    const stored = await AttemptModel.findById(attemptId).lean();
    expect(stored?.activeSessionId).toBe(sessionId);
  });

  it('rejects a second claim from another session', async () => {
    const app = createApp();
    const { studentToken, attemptId } = await seedMcqAndStart(app);

    const first = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, DEFAULT_SESSION))
      .send({ sessionId: DEFAULT_SESSION });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, OTHER_SESSION))
      .send({ sessionId: OTHER_SESSION });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(ErrorCodes.EXAM_SESSION_CONFLICT);
  });

  it('extends the lock on heartbeat (re-claim)', async () => {
    const app = createApp();
    const { studentToken, attemptId } = await seedMcqAndStart(app);

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-06-01T12:00:00.000Z');
    vi.setSystemTime(start);

    const first = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, DEFAULT_SESSION))
      .send({ sessionId: DEFAULT_SESSION });
    expect(first.status).toBe(200);
    const firstExpiry = Date.parse(first.body.data.expiresAt);

    vi.setSystemTime(new Date(start.getTime() + 20_000));

    const refreshed = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, DEFAULT_SESSION))
      .send({ sessionId: DEFAULT_SESSION });
    expect(refreshed.status).toBe(200);
    const secondExpiry = Date.parse(refreshed.body.data.expiresAt);

    expect(secondExpiry).toBeGreaterThan(firstExpiry);
    expect(secondExpiry - (start.getTime() + 20_000)).toBe(EXAM_SESSION_LOCK_TTL_MS);
  });

  it('ignores lock after attempt is terminal', async () => {
    const app = createApp();
    const { studentToken, attemptId, questionId, version } = await seedMcqAndStart(app);

    await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, DEFAULT_SESSION))
      .send({ sessionId: DEFAULT_SESSION });

    await request(app)
      .patch(`/attempts/${attemptId}/answers`)
      .set(bearer(studentToken, DEFAULT_SESSION))
      .send({
        version,
        answers: [{ questionId, selectedOptionId: 'B' }],
      });

    const submitted = await request(app)
      .post(`/attempts/${attemptId}/submit`)
      .set(bearer(studentToken, DEFAULT_SESSION));
    expect(submitted.status).toBe(200);

    const afterSubmit = await AttemptModel.findById(attemptId).lean();
    expect(afterSubmit?.status).toBe('SUBMITTED');
    expect(afterSubmit?.activeSessionId).toBeNull();

    const otherClaim = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, OTHER_SESSION))
      .send({ sessionId: OTHER_SESSION });
    expect(otherClaim.status).toBe(200);
    expect(otherClaim.body.data.locked).toBe(false);
  });

  it('rejects mutations without a valid lock header when another session holds it', async () => {
    const app = createApp();
    const { studentToken, attemptId, questionId, version } = await seedMcqAndStart(app);

    const claim = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, DEFAULT_SESSION))
      .send({ sessionId: DEFAULT_SESSION });
    expect(claim.status).toBe(200);

    const missingHeader = await request(app)
      .patch(`/attempts/${attemptId}/answers`)
      .set({ Authorization: `Bearer ${studentToken}` })
      .send({
        version,
        answers: [{ questionId, selectedOptionId: 'B' }],
      });
    expect(missingHeader.status).toBe(400);

    const otherSession = await request(app)
      .patch(`/attempts/${attemptId}/answers`)
      .set(bearer(studentToken, OTHER_SESSION))
      .send({
        version,
        answers: [{ questionId, selectedOptionId: 'B' }],
      });
    expect(otherSession.status).toBe(409);
    expect(otherSession.body.error.code).toBe(ErrorCodes.EXAM_SESSION_CONFLICT);
  });

  it('releases the lock so another session can claim', async () => {
    const app = createApp();
    const { studentToken, attemptId } = await seedMcqAndStart(app);

    await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, DEFAULT_SESSION))
      .send({ sessionId: DEFAULT_SESSION });

    const released = await request(app)
      .delete(`/attempts/${attemptId}/session`)
      .set(bearer(studentToken, DEFAULT_SESSION));
    expect(released.status).toBe(200);

    const second = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, OTHER_SESSION))
      .send({ sessionId: OTHER_SESSION });
    expect(second.status).toBe(200);
    expect(second.body.data.sessionId).toBe(OTHER_SESSION);
  });

  it('allows a new session to claim after the lock TTL expires', async () => {
    const app = createApp();
    const { studentToken, attemptId } = await seedMcqAndStart(app);

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-06-01T12:00:00.000Z');
    vi.setSystemTime(start);

    await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, DEFAULT_SESSION))
      .send({ sessionId: DEFAULT_SESSION });

    vi.setSystemTime(new Date(start.getTime() + EXAM_SESSION_LOCK_TTL_MS + 1));

    const takeover = await request(app)
      .post(`/attempts/${attemptId}/session/claim`)
      .set(bearer(studentToken, OTHER_SESSION))
      .send({ sessionId: OTHER_SESSION });
    expect(takeover.status).toBe(200);
    expect(takeover.body.data.sessionId).toBe(OTHER_SESSION);
  });
});
