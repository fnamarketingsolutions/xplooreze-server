import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { QuestionModel } from '../src/database/models/question.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword } from '../src/modules/auth/password';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const missingId = new Types.ObjectId().toString();
const mcqScoring = { correctMarks: 4, incorrectMarks: 0, unansweredMarks: 0 };

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

async function createCategory(app: App, adminToken: string) {
  const response = await request(app)
    .post('/admin/categories')
    .set(bearer(adminToken))
    .send({ name: 'Mathematics' });
  expect(response.status).toBe(201);
  return response.body.data as { id: string };
}

async function createModule(app: App, adminToken: string, categoryId: string) {
  const response = await request(app)
    .post('/admin/modules')
    .set(bearer(adminToken))
    .send({ categoryId, name: 'Algebra' });
  expect(response.status).toBe(201);
  return response.body.data as { id: string };
}

async function createTestSeries(app: App, adminToken: string, body: Record<string, unknown>) {
  const response = await request(app).post('/admin/test-series').set(bearer(adminToken)).send(body);
  expect(response.status).toBe(201);
  return response.body.data as { id: string; type: string };
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

describe('questions API', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await QuestionModel.createIndexes();
    await TestSeriesModel.createIndexes();
  }, 60_000);

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

  async function seedHierarchy(app: App, adminToken: string) {
    const category = await createCategory(app, adminToken);
    const module = await createModule(app, adminToken, category.id);
    const mcq = await createTestSeries(app, adminToken, {
      moduleId: module.id,
      title: 'MCQ Series',
      type: 'MCQ',
      duration: 3600,
      scoring: mcqScoring,
    });
    const pdf = await createTestSeries(app, adminToken, {
      moduleId: module.id,
      title: 'PDF Series',
      type: 'PDF',
      duration: 7200,
      access: { price: 49900 },
    });
    const editor = await createTestSeries(app, adminToken, {
      moduleId: module.id,
      title: 'EDITOR Series',
      type: 'EDITOR',
      duration: 5400,
      access: { price: 79900 },
    });

    return { category, module, mcq, pdf, editor };
  }

  describe('authorization', () => {
    it('rejects unauthenticated, student, and evaluator question mutation', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const adminToken = await login(app, 'admin@example.com');
      const { mcq } = await seedHierarchy(app, adminToken);

      const body = {
        testSeriesId: mcq.id,
        position: 1,
        questionText: 'What is 2 + 2?',
        content: mcqContent(),
      };

      const unauthenticated = await request(app).post('/admin/questions').send(body);
      const student = await request(app)
        .post('/admin/questions')
        .set(bearer(studentToken))
        .send({ ...body, userId: missingId, role: 'ADMIN' });
      const evaluator = await request(app)
        .post('/admin/questions')
        .set(bearer(evaluatorToken))
        .send(body);

      expect(unauthenticated.status).toBe(401);
      expect(student.status).toBe(403);
      expect(evaluator.status).toBe(403);
    });
  });

  describe('creation and hierarchy', () => {
    it('lets admin create questions under Category → Module → Test Series', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const { category, module, mcq } = await seedHierarchy(app, adminToken);

      const response = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        position: 1,
        questionText: 'What is 2 + 2?',
        content: mcqContent(),
      });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({
        testSeriesId: mcq.id,
        type: 'MCQ',
        position: 1,
        questionText: 'What is 2 + 2?',
        status: 'ACTIVE',
        content: {
          correctOptionId: 'B',
        },
      });
      expect(response.body.data).not.toHaveProperty('_id');
      expect(response.body.data).not.toHaveProperty('__v');
      expect(response.body.data).not.toHaveProperty('deletedAt');

      const stored = await QuestionModel.findById(response.body.data.id).lean();
      expect(stored?.testSeriesId.toString()).toBe(mcq.id);

      const parent = await TestSeriesModel.findById(mcq.id).lean();
      expect(parent?.moduleId.toString()).toBe(module.id);
      expect(category.id).toBeTruthy();
    });

    it('rejects nonexistent and soft-deleted Test Series parents', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const { mcq } = await seedHierarchy(app, adminToken);

      await request(app).delete(`/admin/test-series/${mcq.id}`).set(bearer(adminToken));

      const missing = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: missingId,
        position: 1,
        questionText: 'Q',
        content: mcqContent(),
      });
      const deleted = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        position: 1,
        questionText: 'Q',
        content: mcqContent(),
      });

      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe(ErrorCodes.TEST_SERIES_NOT_FOUND);
      expect(deleted.status).toBe(404);
      expect(deleted.body.error.code).toBe(ErrorCodes.TEST_SERIES_NOT_FOUND);
    });

    it('rejects type mismatch between Question and Test Series', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const { mcq, pdf, editor } = await seedHierarchy(app, adminToken);

      const mcqOnPdf = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: pdf.id,
        type: 'MCQ',
        position: 1,
        questionText: 'Q',
        content: mcqContent(),
      });
      const editorOnMcq = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: mcq.id,
          type: 'EDITOR',
          position: 1,
          questionText: 'Q',
          content: { body: 'text' },
        });
      const pdfOnEditor = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: editor.id,
        type: 'PDF',
        position: 1,
        questionText: 'Q',
        content: {},
      });

      expect(mcqOnPdf.status).toBe(400);
      expect(editorOnMcq.status).toBe(400);
      expect(pdfOnEditor.status).toBe(400);
    });
  });

  describe('MCQ', () => {
    it('accepts valid single-answer MCQ and rejects invalid MCQ shapes', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const { mcq } = await seedHierarchy(app, adminToken);

      const valid = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: mcq.id,
          position: 1,
          questionText: 'What is 2 + 2?',
          content: mcqContent('B'),
        });
      expect(valid.status).toBe(201);
      expect(valid.body.data.content.correctOptionId).toBe('B');

      const cases = [
        {
          content: { options: [], correctOptionId: 'A' },
        },
        {
          content: {
            options: [
              { id: 'A', text: '1' },
              { id: 'A', text: '2' },
            ],
            correctOptionId: 'A',
          },
        },
        {
          content: {
            options: [{ id: 'A', text: '1' }],
            correctOptionId: 'Z',
          },
        },
        {
          content: {
            options: [{ id: 'A', text: '1' }],
            correctOptionIds: ['A'],
          },
        },
      ];

      for (const [index, payload] of cases.entries()) {
        const response = await request(app)
          .post('/admin/questions')
          .set(bearer(adminToken))
          .send({
            testSeriesId: mcq.id,
            position: index + 10,
            questionText: 'Q',
            ...payload,
          });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }

      const written = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        type: 'WRITTEN',
        position: 20,
        questionText: 'Essay',
        content: mcqContent(),
      });
      expect(written.status).toBe(400);
    });
  });

  describe('PDF and EDITOR', () => {
    it('supports text-based and flexible question-paper PDF representations', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const { pdf, mcq } = await seedHierarchy(app, adminToken);

      const textBased = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: pdf.id,
          position: 1,
          questionText: 'Explain variance analysis.',
          content: { notes: 'structured text prompt' },
        });
      const questionPaper = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: pdf.id,
          position: 2,
          questionText: '',
          content: {},
        });
      const incompatible = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: pdf.id,
          position: 3,
          questionText: 'Q',
          content: 'not-an-object',
        });
      const pdfUnderMcq = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        type: 'PDF',
        position: 3,
        questionText: 'Q',
        content: {},
      });

      expect(textBased.status).toBe(201);
      expect(textBased.body.data.type).toBe('PDF');
      expect(questionPaper.status).toBe(201);
      expect(questionPaper.body.data.type).toBe('PDF');
      expect(incompatible.status).toBe(400);
      expect(pdfUnderMcq.status).toBe(400);
    });

    it('supports Rich Text EDITOR questions and rejects unsupported capabilities', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const { editor, mcq, pdf } = await seedHierarchy(app, adminToken);

      const valid = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: editor.id,
          position: 1,
          questionText: 'Write a short note on costing.',
          content: { format: 'richtext', body: 'Student writes here' },
        });
      const withImages = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: editor.id,
          position: 2,
          questionText: 'Prompt',
          content: { body: 'x', images: [] },
        });
      const withCode = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: editor.id,
          position: 3,
          questionText: 'Prompt',
          content: { body: 'x', sandbox: true, testCases: [] },
        });
      const underMcq = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: mcq.id,
          type: 'EDITOR',
          position: 4,
          questionText: 'Prompt',
          content: { body: 'x' },
        });
      const underPdf = await request(app)
        .post('/admin/questions')
        .set(bearer(adminToken))
        .send({
          testSeriesId: pdf.id,
          type: 'EDITOR',
          position: 4,
          questionText: 'Prompt',
          content: { body: 'x' },
        });

      expect(valid.status).toBe(201);
      expect(valid.body.data.type).toBe('EDITOR');
      expect(withImages.status).toBe(400);
      expect(withCode.status).toBe(400);
      expect(underMcq.status).toBe(400);
      expect(underPdf.status).toBe(400);
    });
  });

  describe('position and lifecycle', () => {
    it('enforces unique position per Test Series and allows reuse across series', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const { mcq, pdf } = await seedHierarchy(app, adminToken);

      const first = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        position: 1,
        questionText: 'Q1',
        content: mcqContent(),
      });
      const duplicate = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        position: 1,
        questionText: 'Q1 duplicate',
        content: mcqContent(),
      });
      const otherSeries = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: pdf.id,
        position: 1,
        questionText: 'PDF Q1',
        content: {},
      });

      expect(first.status).toBe(201);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe(ErrorCodes.QUESTION_POSITION_CONFLICT);
      expect(otherSeries.status).toBe(201);

      const concurrent = await Promise.all([
        request(app).post('/admin/questions').set(bearer(adminToken)).send({
          testSeriesId: mcq.id,
          position: 5,
          questionText: 'Concurrent A',
          content: mcqContent(),
        }),
        request(app).post('/admin/questions').set(bearer(adminToken)).send({
          testSeriesId: mcq.id,
          position: 5,
          questionText: 'Concurrent B',
          content: mcqContent(),
        }),
      ]);

      const statuses = concurrent.map((response) => response.status).sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('supports ACTIVE/INACTIVE/ARCHIVED, rejects DRAFT, and soft-deletes', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const { mcq } = await seedHierarchy(app, adminToken);

      const created = await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        position: 1,
        questionText: 'Lifecycle',
        content: mcqContent(),
        status: 'ACTIVE',
      });
      expect(created.status).toBe(201);

      const inactive = await request(app)
        .patch(`/admin/questions/${created.body.data.id}`)
        .set(bearer(adminToken))
        .send({ status: 'INACTIVE' });
      const archived = await request(app)
        .patch(`/admin/questions/${created.body.data.id}`)
        .set(bearer(adminToken))
        .send({ status: 'ARCHIVED' });
      const draft = await request(app)
        .patch(`/admin/questions/${created.body.data.id}`)
        .set(bearer(adminToken))
        .send({ status: 'DRAFT' });
      const operators = await request(app)
        .patch(`/admin/questions/${created.body.data.id}`)
        .set(bearer(adminToken))
        .send({ $set: { status: 'ACTIVE' } });

      expect(inactive.status).toBe(200);
      expect(inactive.body.data.status).toBe('INACTIVE');
      expect(archived.status).toBe(200);
      expect(archived.body.data.status).toBe('ARCHIVED');
      expect(draft.status).toBe(400);
      expect(operators.status).toBe(400);

      const deleted = await request(app)
        .delete(`/admin/questions/${created.body.data.id}`)
        .set(bearer(adminToken));
      expect(deleted.status).toBe(200);

      const getDeleted = await request(app)
        .get(`/admin/questions/${created.body.data.id}`)
        .set(bearer(adminToken));
      const list = await request(app)
        .get('/admin/questions')
        .query({ testSeriesId: mcq.id })
        .set(bearer(adminToken));

      expect(getDeleted.status).toBe(404);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(0);

      const stored = await QuestionModel.findById(created.body.data.id).lean();
      expect(stored?.deletedAt).toBeTruthy();
    });

    it('lists and retrieves admin questions ordered by position', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const { mcq } = await seedHierarchy(app, adminToken);

      await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        position: 2,
        questionText: 'Second',
        content: mcqContent(),
      });
      await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: mcq.id,
        position: 1,
        questionText: 'First',
        content: mcqContent(),
      });

      const list = await request(app)
        .get('/admin/questions')
        .query({ testSeriesId: mcq.id })
        .set(bearer(adminToken));
      const studentList = await request(app)
        .get('/admin/questions')
        .query({ testSeriesId: mcq.id })
        .set(bearer(studentToken));

      expect(list.status).toBe(200);
      expect(list.body.data.map((item: { position: number }) => item.position)).toEqual([1, 2]);
      expect(list.body.data[0].content.correctOptionId).toBe('B');
      expect(studentList.status).toBe(403);

      const detail = await request(app)
        .get(`/admin/questions/${list.body.data[0].id}`)
        .set(bearer(adminToken));
      expect(detail.status).toBe(200);
      expect(detail.body.data.questionText).toBe('First');
    });
  });
});
