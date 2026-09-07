import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { CategoryModel } from '../src/database/models/category.model';
import { ModuleModel } from '../src/database/models/module.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword } from '../src/modules/auth/password';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const missingId = new Types.ObjectId().toString();

const mcqScoring = { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 };

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

async function createCategory(
  app: App,
  adminToken: string,
  body: Record<string, unknown> = { name: 'Mathematics' },
) {
  const response = await request(app).post('/admin/categories').set(bearer(adminToken)).send(body);
  expect(response.status).toBe(201);
  return response.body.data as { id: string; name: string; status: string };
}

async function createModule(app: App, adminToken: string, body: Record<string, unknown>) {
  const response = await request(app).post('/admin/modules').set(bearer(adminToken)).send(body);
  expect(response.status).toBe(201);
  return response.body.data as { id: string; categoryId: string; name: string };
}

async function createTestSeries(app: App, adminToken: string, body: Record<string, unknown>) {
  const response = await request(app).post('/admin/test-series').set(bearer(adminToken)).send(body);
  expect(response.status).toBe(201);
  return response.body.data as {
    id: string;
    moduleId: string;
    type: string;
    attemptPolicy: { maxAttempts: number | null };
    access: { isFree: boolean; price: number; currency: string };
    scoring?: { maxScore?: number; correctMarks?: number };
  };
}

describe('catalog API', () => {
  beforeAll(async () => {
    await startMemoryMongo();
    await CategoryModel.createIndexes();
    await ModuleModel.createIndexes();
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

  describe('authorization', () => {
    it('rejects unauthenticated, student, and evaluator catalog writes', async () => {
      const app = createApp();
      const studentToken = await login(app, 'student@example.com');
      const evaluatorToken = await login(app, 'evaluator@example.com');

      const unauthenticatedCategory = await request(app)
        .post('/admin/categories')
        .send({ name: 'Math' });
      const unauthenticatedModule = await request(app)
        .post('/admin/modules')
        .send({ categoryId: missingId, name: 'Algebra' });
      const unauthenticatedSeries = await request(app)
        .post('/admin/test-series')
        .send({ moduleId: missingId, title: 'Mock', type: 'MCQ', duration: 3600 });
      const student = await request(app)
        .post('/admin/categories')
        .set(bearer(studentToken))
        .send({ name: 'Math', userId: missingId, role: 'ADMIN' });
      const evaluatorCategory = await request(app)
        .post('/admin/categories')
        .set(bearer(evaluatorToken))
        .send({ name: 'Math' });
      const evaluatorModule = await request(app)
        .post('/admin/modules')
        .set(bearer(evaluatorToken))
        .send({ categoryId: missingId, name: 'Algebra' });
      const evaluatorSeries = await request(app)
        .post('/admin/test-series')
        .set(bearer(evaluatorToken))
        .send({ moduleId: missingId, title: 'Mock', type: 'MCQ', duration: 3600 });
      const studentSeries = await request(app)
        .post('/admin/test-series')
        .set(bearer(studentToken))
        .send({ moduleId: missingId, title: 'Mock', type: 'MCQ', duration: 3600 });

      expect(unauthenticatedCategory.status).toBe(401);
      expect(unauthenticatedModule.status).toBe(401);
      expect(unauthenticatedSeries.status).toBe(401);
      expect(student.status).toBe(403);
      expect(evaluatorCategory.status).toBe(403);
      expect(evaluatorModule.status).toBe(403);
      expect(evaluatorSeries.status).toBe(403);
      expect(studentSeries.status).toBe(403);
      expect(student.body.error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it('allows admin writes and public catalog reads for guest, student, and evaluator', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const evaluatorToken = await login(app, 'evaluator@example.com');

      const category = await createCategory(app, adminToken);
      const listed = await request(app).get('/categories').set(bearer(studentToken));
      const evaluatorListed = await request(app).get('/categories').set(bearer(evaluatorToken));
      const unauthenticated = await request(app).get('/categories');

      expect(category.name).toBe('Mathematics');
      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(1);
      expect(evaluatorListed.status).toBe(200);
      expect(unauthenticated.status).toBe(200);
      expect(unauthenticated.body.data).toHaveLength(1);
    });
  });

  describe('categories', () => {
    it('creates, updates, and hides inactive and soft-deleted records from student reads', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');

      const created = await createCategory(app, adminToken, {
        name: '  Physics  ',
        description: 'Mechanics',
      });
      expect(created).toMatchObject({
        name: 'Physics',
        description: 'Mechanics',
        status: 'ACTIVE',
      });
      expect(created).not.toHaveProperty('_id');
      expect(created).not.toHaveProperty('deletedAt');

      const invalid = await request(app)
        .post('/admin/categories')
        .set(bearer(adminToken))
        .send({ name: '' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      await request(app)
        .patch(`/admin/categories/${created.id}`)
        .set(bearer(adminToken))
        .send({ status: 'INACTIVE' });

      const studentList = await request(app).get('/categories').set(bearer(studentToken));
      const studentGet = await request(app)
        .get(`/categories/${created.id}`)
        .set(bearer(studentToken));
      const adminList = await request(app)
        .get('/admin/categories?status=INACTIVE')
        .set(bearer(adminToken));

      expect(studentList.body.data).toHaveLength(0);
      expect(studentGet.status).toBe(404);
      expect(adminList.body.data).toHaveLength(1);

      await request(app)
        .patch(`/admin/categories/${created.id}`)
        .set(bearer(adminToken))
        .send({ status: 'ACTIVE' });
      await request(app).delete(`/admin/categories/${created.id}`).set(bearer(adminToken));

      const afterDelete = await request(app).get('/categories').set(bearer(studentToken));
      const adminAfterDelete = await request(app).get('/admin/categories').set(bearer(adminToken));
      expect(afterDelete.body.data).toHaveLength(0);
      expect(adminAfterDelete.body.data).toHaveLength(0);
    });

    it('rejects duplicate active category names including concurrent creates', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');

      await createCategory(app, adminToken, { name: 'Biology' });
      const duplicate = await request(app)
        .post('/admin/categories')
        .set(bearer(adminToken))
        .send({ name: 'Biology' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe(ErrorCodes.CATEGORY_NAME_CONFLICT);

      const [first, second] = await Promise.all([
        request(app).post('/admin/categories').set(bearer(adminToken)).send({ name: 'Chemistry' }),
        request(app).post('/admin/categories').set(bearer(adminToken)).send({ name: 'Chemistry' }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe('modules', () => {
    it('creates modules under a category and rejects missing or deleted parents', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const category = await createCategory(app, adminToken);

      const studentCreate = await request(app)
        .post('/admin/modules')
        .set(bearer(studentToken))
        .send({ categoryId: category.id, name: 'Algebra' });
      expect(studentCreate.status).toBe(403);

      const missingParent = await request(app)
        .post('/admin/modules')
        .set(bearer(adminToken))
        .send({ categoryId: missingId, name: 'Algebra' });
      expect(missingParent.status).toBe(404);
      expect(missingParent.body.error.code).toBe(ErrorCodes.CATEGORY_NOT_FOUND);

      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });
      expect(module.categoryId).toBe(category.id);

      await request(app).delete(`/admin/categories/${category.id}`).set(bearer(adminToken));
      const deletedParent = await request(app)
        .post('/admin/modules')
        .set(bearer(adminToken))
        .send({ categoryId: category.id, name: 'Calculus' });
      expect(deletedParent.status).toBe(404);
    });

    it('rejects duplicate active module names in a category and allows the same name in another category', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const math = await createCategory(app, adminToken, { name: 'Mathematics' });
      const physics = await createCategory(app, adminToken, { name: 'Physics' });

      await createModule(app, adminToken, { categoryId: math.id, name: 'Algebra' });
      const duplicate = await request(app)
        .post('/admin/modules')
        .set(bearer(adminToken))
        .send({ categoryId: math.id, name: 'Algebra' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe(ErrorCodes.MODULE_NAME_CONFLICT);

      const other = await createModule(app, adminToken, {
        categoryId: physics.id,
        name: 'Algebra',
      });
      expect(other.categoryId).toBe(physics.id);

      const reassign = await request(app)
        .patch(`/admin/modules/${other.id}`)
        .set(bearer(adminToken))
        .send({ categoryId: math.id });
      expect(reassign.status).toBe(400);
    });

    it('updates modules, hides inactive and soft-deleted records, and lists by category', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const category = await createCategory(app, adminToken);
      const other = await createCategory(app, adminToken, { name: 'Physics' });
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
        description: 'Core',
      });

      const updated = await request(app)
        .patch(`/admin/modules/${module.id}`)
        .set(bearer(adminToken))
        .send({ name: 'Algebra I', description: 'Updated', status: 'INACTIVE' });
      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({
        name: 'Algebra I',
        description: 'Updated',
        status: 'INACTIVE',
        categoryId: category.id,
      });

      const studentList = await request(app)
        .get(`/modules?categoryId=${category.id}`)
        .set(bearer(studentToken));
      const studentGet = await request(app).get(`/modules/${module.id}`).set(bearer(studentToken));
      const adminGet = await request(app)
        .get(`/admin/modules/${module.id}`)
        .set(bearer(adminToken));

      expect(studentList.body.data).toHaveLength(0);
      expect(studentGet.status).toBe(404);
      expect(adminGet.body.data.status).toBe('INACTIVE');

      await request(app)
        .patch(`/admin/modules/${module.id}`)
        .set(bearer(adminToken))
        .send({ status: 'ACTIVE' });
      const visible = await request(app)
        .get(`/modules?categoryId=${category.id}`)
        .set(bearer(studentToken));
      expect(visible.body.data).toHaveLength(1);
      expect(visible.body.data[0].id).toBe(module.id);

      const otherListed = await request(app)
        .get(`/modules?categoryId=${other.id}`)
        .set(bearer(studentToken));
      expect(otherListed.body.data).toHaveLength(0);

      await request(app).delete(`/admin/modules/${module.id}`).set(bearer(adminToken));
      const afterDelete = await request(app)
        .get(`/modules?categoryId=${category.id}`)
        .set(bearer(studentToken));
      const adminAfterDelete = await request(app)
        .get(`/admin/modules?categoryId=${category.id}`)
        .set(bearer(adminToken));
      expect(afterDelete.body.data).toHaveLength(0);
      expect(adminAfterDelete.body.data).toHaveLength(0);
    });
  });

  describe('test series', () => {
    it('creates MCQ, PDF, and EDITOR series under a module with canonical configuration', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const category = await createCategory(app, adminToken);
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });

      const mcq = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Algebra MCQ',
        type: 'MCQ',
        duration: 3600,
        scoring: mcqScoring,
      });
      const pdf = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Algebra PDF',
        type: 'PDF',
        duration: 7200,
        access: { price: 49900 },
      });
      const editor = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Algebra Editor',
        type: 'EDITOR',
        duration: 5400,
        access: { isFree: false, price: 79900, currency: 'INR' },
      });

      expect(mcq).toMatchObject({
        type: 'MCQ',
        evaluationMode: 'AUTOMATIC',
        access: { isFree: true, price: 0, currency: 'INR' },
        attemptPolicy: { maxAttempts: null },
        scoring: { ...mcqScoring, maxScore: 100 },
      });
      expect(mcq).not.toHaveProperty('categoryId');
      expect(pdf).toMatchObject({
        type: 'PDF',
        evaluationMode: 'MANUAL',
        access: { isFree: false, price: 49900, currency: 'INR' },
        attemptPolicy: { maxAttempts: 3 },
        scoring: { maxScore: 100 },
      });
      expect(editor.access.isFree).toBe(false);
      expect(editor.attemptPolicy.maxAttempts).toBe(3);
      expect(editor.scoring).toEqual({ maxScore: 100 });

      const stored = await TestSeriesModel.findById(mcq.id).lean();
      expect(stored).not.toHaveProperty('categoryId');
      expect(stored?.moduleId.toString()).toBe(module.id);
      expect(stored?.attemptPolicy.maxAttempts ?? null).toBeNull();
    });

    it('rejects invalid types, duration, pricing, parents, and attempt-policy overrides', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const category = await createCategory(app, adminToken);
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });

      const studentCreate = await request(app)
        .post('/admin/test-series')
        .set(bearer(studentToken))
        .send({
          moduleId: module.id,
          title: 'Nope',
          type: 'MCQ',
          duration: 3600,
          scoring: mcqScoring,
        });
      expect(studentCreate.status).toBe(403);

      const missingModule = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: missingId,
          title: 'Nope',
          type: 'MCQ',
          duration: 3600,
          scoring: mcqScoring,
        });
      expect(missingModule.status).toBe(404);

      await request(app).delete(`/admin/modules/${module.id}`).set(bearer(adminToken));
      const deletedModule = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: module.id,
          title: 'Nope',
          type: 'MCQ',
          duration: 3600,
          scoring: mcqScoring,
        });
      expect(deletedModule.status).toBe(404);

      const liveModule = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Calculus',
      });

      const written = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: liveModule.id,
          title: 'Essay',
          type: 'WRITTEN',
          duration: 3600,
          access: { price: 49900 },
        });
      const invalidType = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: liveModule.id,
          title: 'Essay',
          type: 'QUIZ',
          duration: 3600,
        });
      const negativeDuration = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: liveModule.id,
          title: 'MCQ',
          type: 'MCQ',
          duration: -1,
          scoring: mcqScoring,
        });
      const paidMcq = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: liveModule.id,
          title: 'Paid MCQ',
          type: 'MCQ',
          duration: 3600,
          scoring: mcqScoring,
          access: { isFree: false, price: 100 },
        });
      const freePdf = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: liveModule.id,
          title: 'Free PDF',
          type: 'PDF',
          duration: 3600,
          access: { isFree: true, price: 0 },
        });
      const attemptOverride = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: liveModule.id,
          title: 'MCQ',
          type: 'MCQ',
          duration: 3600,
          scoring: mcqScoring,
          attemptPolicy: { maxAttempts: 99 },
        });
      const floatPrice = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: liveModule.id,
          title: 'PDF',
          type: 'PDF',
          duration: 3600,
          access: { price: 499.5 },
        });
      const withCategoryId = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: liveModule.id,
          categoryId: category.id,
          title: 'MCQ',
          type: 'MCQ',
          duration: 3600,
          scoring: mcqScoring,
        });

      expect(written.status).toBe(400);
      expect(invalidType.status).toBe(400);
      expect(negativeDuration.status).toBe(400);
      expect(paidMcq.status).toBe(400);
      expect(freePdf.status).toBe(400);
      expect(attemptOverride.status).toBe(400);
      expect(floatPrice.status).toBe(400);
      expect(withCategoryId.status).toBe(400);
    });

    it('validates availability windows and exposes currently-available state', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const category = await createCategory(app, adminToken);
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });

      const inverted = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: module.id,
          title: 'Window',
          type: 'MCQ',
          duration: 3600,
          scoring: mcqScoring,
          availability: {
            startsAt: '2026-08-25T00:00:00.000Z',
            endsAt: '2026-08-20T00:00:00.000Z',
          },
        });
      expect(inverted.status).toBe(400);

      const future = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Future',
        type: 'MCQ',
        duration: 3600,
        scoring: mcqScoring,
        availability: {
          startsAt: '2099-01-01T00:00:00.000Z',
          endsAt: null,
        },
      });
      const always = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Always',
        type: 'MCQ',
        duration: 3600,
        scoring: mcqScoring,
      });

      const futureGet = await request(app)
        .get(`/test-series/${future.id}`)
        .set(bearer(studentToken));
      const alwaysGet = await request(app)
        .get(`/test-series/${always.id}`)
        .set(bearer(studentToken));

      expect(futureGet.body.data.isAvailable).toBe(false);
      expect(alwaysGet.body.data.isAvailable).toBe(true);
      expect(alwaysGet.body.data.availability).toEqual({ startsAt: null, endsAt: null });
    });

    it('hides inactive and deleted series from student catalog reads and forbids parent reassignment', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const category = await createCategory(app, adminToken);
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });
      const series = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Visible',
        type: 'MCQ',
        duration: 3600,
        scoring: mcqScoring,
      });

      const listed = await request(app)
        .get(`/test-series?moduleId=${module.id}`)
        .set(bearer(studentToken));
      expect(listed.body.data).toHaveLength(1);

      await request(app)
        .patch(`/admin/test-series/${series.id}`)
        .set(bearer(adminToken))
        .send({ status: 'ARCHIVED' });
      const afterArchive = await request(app)
        .get(`/test-series/${series.id}`)
        .set(bearer(studentToken));
      expect(afterArchive.status).toBe(404);

      await request(app)
        .patch(`/admin/test-series/${series.id}`)
        .set(bearer(adminToken))
        .send({ status: 'ACTIVE' });
      await request(app).delete(`/admin/test-series/${series.id}`).set(bearer(adminToken));
      const afterDelete = await request(app).get('/test-series').set(bearer(studentToken));
      expect(afterDelete.body.data).toHaveLength(0);

      const live = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Live',
        type: 'MCQ',
        duration: 3600,
        scoring: mcqScoring,
      });
      const move = await request(app)
        .patch(`/admin/test-series/${live.id}`)
        .set(bearer(adminToken))
        .send({ moduleId: missingId, type: 'PDF' });
      expect(move.status).toBe(400);

      const studentUpdate = await request(app)
        .patch(`/admin/test-series/${live.id}`)
        .set(bearer(studentToken))
        .send({ title: 'Hacked' });
      expect(studentUpdate.status).toBe(403);
    });
  });

  describe('hierarchy', () => {
    it('keeps Category → Module → Test Series with moduleId as the only parent on test series', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');

      const category = await createCategory(app, adminToken, { name: 'Mathematics' });
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });
      const series = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Algebra Mock 1',
        type: 'MCQ',
        duration: 3600,
        scoring: mcqScoring,
      });

      const modules = await request(app)
        .get(`/modules?categoryId=${category.id}`)
        .set(bearer(studentToken));
      const seriesList = await request(app)
        .get(`/test-series?categoryId=${category.id}`)
        .set(bearer(studentToken));
      const stored = await TestSeriesModel.findById(series.id).lean();

      expect(modules.body.data[0].categoryId).toBe(category.id);
      expect(seriesList.body.data[0].moduleId).toBe(module.id);
      expect(seriesList.body.data[0]).not.toHaveProperty('categoryId');
      expect(stored).not.toHaveProperty('categoryId');
      expect(Object.keys(stored ?? {})).not.toContain('categoryId');
    });
  });

  describe('security and responses', () => {
    it('rejects MongoDB operators and extra identity fields from request bodies', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const category = await createCategory(app, adminToken);
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });
      const series = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Mock',
        type: 'MCQ',
        duration: 3600,
        scoring: mcqScoring,
      });

      const categoryOperator = await request(app)
        .patch(`/admin/categories/${category.id}`)
        .set(bearer(adminToken))
        .send({ $set: { name: 'Hacked' } });
      const moduleOperator = await request(app)
        .patch(`/admin/modules/${module.id}`)
        .set(bearer(adminToken))
        .send({ $unset: { name: 1 } });
      const seriesOperator = await request(app)
        .patch(`/admin/test-series/${series.id}`)
        .set(bearer(adminToken))
        .send({ $inc: { duration: 60 } });

      expect(categoryOperator.status).toBe(400);
      expect(moduleOperator.status).toBe(400);
      expect(seriesOperator.status).toBe(400);
    });

    it('returns explicit DTO fields without secrets or persistence internals', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const category = await createCategory(app, adminToken, {
        name: 'Mathematics',
        description: 'STEM',
      });
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });
      const series = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Algebra Mock 1',
        type: 'MCQ',
        duration: 3600,
        scoring: mcqScoring,
      });

      const studentCategory = await request(app)
        .get(`/categories/${category.id}`)
        .set(bearer(studentToken));
      const studentModule = await request(app)
        .get(`/modules/${module.id}`)
        .set(bearer(studentToken));
      const studentSeries = await request(app)
        .get(`/test-series/${series.id}`)
        .set(bearer(studentToken));
      const adminSeries = await request(app)
        .get(`/admin/test-series/${series.id}`)
        .set(bearer(adminToken));

      expect(Object.keys(studentCategory.body.data).sort()).toEqual(
        ['description', 'id', 'name', 'status'].sort(),
      );
      expect(Object.keys(studentModule.body.data).sort()).toEqual(
        ['categoryId', 'description', 'id', 'name', 'status'].sort(),
      );
      expect(Object.keys(studentSeries.body.data).sort()).toEqual(
        [
          'access',
          'attemptPolicy',
          'availability',
          'description',
          'duration',
          'evaluationMode',
          'id',
          'isAvailable',
          'moduleId',
          'scoring',
          'status',
          'title',
          'type',
        ].sort(),
      );
      expect(Object.keys(adminSeries.body.data).sort()).toEqual(
        [
          'access',
          'attemptPolicy',
          'availability',
          'createdAt',
          'description',
          'duration',
          'evaluationMode',
          'id',
          'isAvailable',
          'moduleId',
          'scoring',
          'status',
          'title',
          'type',
          'updatedAt',
        ].sort(),
      );

      for (const payload of [
        studentCategory.body.data,
        studentModule.body.data,
        studentSeries.body.data,
        adminSeries.body.data,
      ]) {
        expect(payload).not.toHaveProperty('_id');
        expect(payload).not.toHaveProperty('__v');
        expect(payload).not.toHaveProperty('deletedAt');
        expect(payload).not.toHaveProperty('passwordHash');
        expect(payload).not.toHaveProperty('password');
        expect(payload).not.toHaveProperty('examEndsAt');
      }

      expect(studentModule.body.data).toHaveProperty('categoryId');
      expect(studentSeries.body.data).not.toHaveProperty('categoryId');
      expect(adminSeries.body.data).not.toHaveProperty('categoryId');
      expect(studentSeries.body.data.scoring).toEqual(mcqScoring);
      expect(studentSeries.body.data.scoring).not.toHaveProperty('maxScore');
      expect(adminSeries.body.data.scoring.maxScore).toBe(100);
    });

    it('lets Admin configure and update maxScore and rejects invalid values', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const studentToken = await login(app, 'student@example.com');
      const category = await createCategory(app, adminToken);
      const module = await createModule(app, adminToken, {
        categoryId: category.id,
        name: 'Algebra',
      });

      const pdf = await createTestSeries(app, adminToken, {
        moduleId: module.id,
        title: 'Algebra PDF',
        type: 'PDF',
        duration: 3600,
        access: { price: 49900 },
        scoring: { maxScore: 50 },
      });
      expect(pdf.scoring).toEqual({ maxScore: 50 });

      const updated = await request(app)
        .patch(`/admin/test-series/${pdf.id}`)
        .set(bearer(adminToken))
        .send({ scoring: { maxScore: 120 } });
      expect(updated.status).toBe(200);
      expect(updated.body.data.scoring.maxScore).toBe(120);

      const studentPdf = await request(app).get(`/test-series/${pdf.id}`).set(bearer(studentToken));
      expect(studentPdf.status).toBe(200);
      expect(studentPdf.body.data).not.toHaveProperty('scoring');

      for (const maxScore of [-1, 0, 100.001, '100']) {
        const rejected = await request(app)
          .patch(`/admin/test-series/${pdf.id}`)
          .set(bearer(adminToken))
          .send({ scoring: { maxScore } });
        expect(rejected.status).toBe(400);
        expect(rejected.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }

      const operators = await request(app)
        .patch(`/admin/test-series/${pdf.id}`)
        .set(bearer(adminToken))
        .send({ scoring: { maxScore: 80, $gt: 1 } });
      expect(operators.status).toBe(400);
    });
  });
});
