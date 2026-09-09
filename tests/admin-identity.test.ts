import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AttemptModel } from '../src/database/models/attempt.model';
import { AuditLogModel } from '../src/database/models/audit-log.model';
import { AuthSessionModel } from '../src/database/models/auth-session.model';
import { CategoryModel } from '../src/database/models/category.model';
import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../src/database/models/conventions';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { EvaluationRevisionModel } from '../src/database/models/evaluation-revision.model';
import { EvaluatorCategoryAssignmentModel } from '../src/database/models/evaluator-category-assignment.model';
import { ModuleModel } from '../src/database/models/module.model';
import { QuestionModel } from '../src/database/models/question.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { UserModel } from '../src/database/models/user.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword } from '../src/modules/auth/password';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';
const PRICE_PAISE = 49900;
let mobileSequence = 9876500000;

function nextMobileNumber(): string {
  mobileSequence += 1;
  return `+91${mobileSequence}`;
}

type App = ReturnType<typeof createApp>;

function cookieValue(setCookie: string): string {
  return setCookie.split(';', 1)[0]?.split('=').slice(1).join('=') ?? '';
}

function refreshCookie(response: request.Response): string | undefined {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  return cookies.find((entry) => entry.startsWith('refresh_token='));
}

function bearer(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-exam-session-id': '11111111-1111-4111-8111-111111111111',
  };
}

function assertNoAuthSecrets(payload: unknown, plaintext?: string) {
  const raw = JSON.stringify(payload);
  expect(raw).not.toContain('passwordHash');
  expect(raw).not.toContain('refreshTokenHash');
  expect(raw).not.toContain('refreshToken');
  expect(raw).not.toContain('familyId');
  if (plaintext) {
    expect(raw).not.toContain(plaintext);
  }
}

async function seedAdmin(): Promise<void> {
  await userRepository.create({
    email: 'admin@example.com',
    passwordHash: await hashPassword(PASSWORD),
    role: 'ADMIN',
    status: 'ACTIVE',
    name: { first: 'Ada', last: 'Min' },
  });
}

async function login(app: App, email: string, password = PASSWORD): Promise<string> {
  const response = await request(app).post('/auth/login').send({ email, password });
  expect(response.status).toBe(200);
  return response.body.data.accessToken as string;
}

async function userIdFor(email: string): Promise<string> {
  const user = await userRepository.findByEmail(email);
  expect(user).toBeTruthy();
  return user!._id.toString();
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

describe('Phase 12 Admin Identity & Evaluator Administration', () => {
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
    await EvaluatorCategoryAssignmentModel.createIndexes();
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
    });
    await seedAdmin();
  });

  afterEach(async () => {
    await clearMemoryMongo();
  });

  async function createPrivilegedUser(
    app: App,
    adminToken: string,
    body: {
      email: string;
      role: 'ADMIN' | 'EVALUATOR';
      name?: { first: string; last: string };
      mobileNumber?: string;
    },
  ) {
    const response = await request(app)
      .post('/admin/users')
      .set(bearer(adminToken))
      .send({
        email: body.email,
        password: PASSWORD,
        role: body.role,
        mobileNumber: body.mobileNumber ?? nextMobileNumber(),
        name: body.name ?? { first: 'Priv', last: 'User' },
      });
    expect(response.status).toBe(201);
    return response;
  }

  describe('admin user management', () => {
    it('lists and gets users without authentication secrets', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await request(app)
        .post('/auth/register')
        .send({
          email: 'student@example.com',
          password: PASSWORD,
          mobileNumber: nextMobileNumber(),
          name: { first: 'Stu', last: 'Dent' },
        });

      const listed = await request(app).get('/admin/users').set(bearer(adminToken));
      expect(listed.status).toBe(200);
      expect(listed.body.pagination).toMatchObject({ page: 1, total: 2 });
      expect(listed.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ email: 'admin@example.com', role: 'ADMIN' }),
          expect.objectContaining({ email: 'student@example.com', role: 'STUDENT' }),
        ]),
      );
      for (const user of listed.body.data) {
        expect(user).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            email: expect.any(String),
            role: expect.any(String),
            status: 'ACTIVE',
            name: expect.objectContaining({ first: expect.any(String), last: expect.any(String) }),
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          }),
        );
      }
      assertNoAuthSecrets(listed.body, PASSWORD);

      const studentId = await userIdFor('student@example.com');
      const got = await request(app).get(`/admin/users/${studentId}`).set(bearer(adminToken));
      expect(got.status).toBe(200);
      expect(got.body.data).toMatchObject({
        id: studentId,
        email: 'student@example.com',
        role: 'STUDENT',
        status: 'ACTIVE',
      });
      assertNoAuthSecrets(got.body, PASSWORD);

      const missing = await request(app)
        .get(`/admin/users/${new Types.ObjectId().toString()}`)
        .set(bearer(adminToken));
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe(ErrorCodes.USER_NOT_FOUND);
    });

    it('filters the user list by role and status and rejects unknown filter values', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await request(app)
        .post('/auth/register')
        .send({
          email: 'student@example.com',
          password: PASSWORD,
          mobileNumber: nextMobileNumber(),
          name: { first: 'Stu', last: 'Dent' },
        });
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
      });

      const students = await request(app)
        .get('/admin/users?role=STUDENT')
        .set(bearer(adminToken));
      expect(students.status).toBe(200);
      expect(students.body.pagination).toMatchObject({ total: 1 });
      expect(students.body.data).toEqual([
        expect.objectContaining({ email: 'student@example.com', role: 'STUDENT' }),
      ]);

      const evaluatorId = await userIdFor('evaluator@example.com');
      await request(app)
        .patch(`/admin/users/${evaluatorId}`)
        .set(bearer(adminToken))
        .send({ status: 'DISABLED' });

      const disabled = await request(app)
        .get('/admin/users?status=DISABLED')
        .set(bearer(adminToken));
      expect(disabled.status).toBe(200);
      expect(disabled.body.pagination).toMatchObject({ total: 1 });
      expect(disabled.body.data).toEqual([
        expect.objectContaining({ email: 'evaluator@example.com', status: 'DISABLED' }),
      ]);

      const combined = await request(app)
        .get('/admin/users?role=EVALUATOR&status=ACTIVE')
        .set(bearer(adminToken));
      expect(combined.status).toBe(200);
      expect(combined.body.pagination).toMatchObject({ total: 0 });
      expect(combined.body.data).toEqual([]);

      const byName = await request(app)
        .get('/admin/users?search=Stu')
        .set(bearer(adminToken));
      expect(byName.status).toBe(200);
      expect(byName.body.pagination).toMatchObject({ total: 1 });
      expect(byName.body.data).toEqual([
        expect.objectContaining({ email: 'student@example.com' }),
      ]);

      const byEmail = await request(app)
        .get('/admin/users?search=evaluator@')
        .set(bearer(adminToken));
      expect(byEmail.status).toBe(200);
      expect(byEmail.body.pagination).toMatchObject({ total: 1 });
      expect(byEmail.body.data).toEqual([
        expect.objectContaining({ email: 'evaluator@example.com' }),
      ]);

      const noMatch = await request(app)
        .get('/admin/users?search=zzznomatch')
        .set(bearer(adminToken));
      expect(noMatch.status).toBe(200);
      expect(noMatch.body.pagination).toMatchObject({ total: 0 });
      expect(noMatch.body.data).toEqual([]);

      // Empty filter values behave as "no filter" so the UI can send blank selects.
      const unfiltered = await request(app)
        .get('/admin/users?role=&status=')
        .set(bearer(adminToken));
      expect(unfiltered.status).toBe(200);
      expect(unfiltered.body.pagination).toMatchObject({ total: 3 });

      for (const query of ['role=SUPER_ADMIN', 'status=ARCHIVED', 'role=STUDENT&role=ADMIN']) {
        const rejected = await request(app)
          .get(`/admin/users?${query}`)
          .set(bearer(adminToken));
        expect(rejected.status).toBe(400);
        expect(rejected.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });

    it('creates Evaluator and Admin users and rejects invalid roles', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');

      const evaluator = await createPrivilegedUser(app, adminToken, {
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
        name: { first: 'Eva', last: 'Luator' },
      });
      expect(evaluator.body.data).toMatchObject({
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
        status: 'ACTIVE',
      });
      assertNoAuthSecrets(evaluator.body, PASSWORD);

      const stored = await UserModel.findOne({ email: 'evaluator@example.com' }).lean();
      expect(stored?.passwordHash.startsWith('$argon2')).toBe(true);
      expect(stored?.passwordHash).not.toBe(PASSWORD);

      const createdAdmin = await createPrivilegedUser(app, adminToken, {
        email: 'second-admin@example.com',
        role: 'ADMIN',
      });
      expect(createdAdmin.body.data.role).toBe('ADMIN');

      const studentRole = await request(app)
        .post('/admin/users')
        .set(bearer(adminToken))
        .send({
          email: 'not-allowed@example.com',
          password: PASSWORD,
          role: 'STUDENT',
          mobileNumber: nextMobileNumber(),
          name: { first: 'No', last: 'Pe' },
        });
      expect(studentRole.status).toBe(400);
      expect(studentRole.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      const unknownRole = await request(app)
        .post('/admin/users')
        .set(bearer(adminToken))
        .send({
          email: 'super@example.com',
          password: PASSWORD,
          role: 'SUPER_ADMIN',
          mobileNumber: nextMobileNumber(),
          name: { first: 'Super', last: 'Admin' },
        });
      expect(unknownRole.status).toBe(400);

      const duplicate = await request(app)
        .post('/admin/users')
        .set(bearer(adminToken))
        .send({
          email: 'evaluator@example.com',
          password: PASSWORD,
          role: 'EVALUATOR',
          mobileNumber: nextMobileNumber(),
          name: { first: 'Eva', last: 'Luator' },
        });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe(ErrorCodes.EMAIL_ALREADY_REGISTERED);

      const audits = await AuditLogModel.find({ action: 'USER_CREATED' }).lean();
      expect(audits).toHaveLength(2);
      expect(audits[0]?.actorRole).toBe('ADMIN');
      assertNoAuthSecrets(audits, PASSWORD);
    });

    it('changes role and status, rejects extra PATCH fields, and records audit events', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
      });
      const evaluatorId = await userIdFor('evaluator@example.com');

      const roleChanged = await request(app)
        .patch(`/admin/users/${evaluatorId}`)
        .set(bearer(adminToken))
        .send({ role: 'ADMIN' });
      expect(roleChanged.status).toBe(200);
      expect(roleChanged.body.data.role).toBe('ADMIN');

      const disabled = await request(app)
        .patch(`/admin/users/${evaluatorId}`)
        .set(bearer(adminToken))
        .send({ status: 'DISABLED' });
      expect(disabled.status).toBe(200);
      expect(disabled.body.data.status).toBe('DISABLED');

      const enabled = await request(app)
        .patch(`/admin/users/${evaluatorId}`)
        .set(bearer(adminToken))
        .send({ status: 'ACTIVE' });
      expect(enabled.status).toBe(200);
      expect(enabled.body.data.status).toBe('ACTIVE');

      for (const body of [
        { email: 'other@example.com' },
        { password: 'new-password-12' },
        { name: { first: 'X', last: 'Y' } },
        { passwordHash: 'nope' },
        { deletedAt: null },
        { $set: { role: 'STUDENT' } },
      ]) {
        const rejected = await request(app)
          .patch(`/admin/users/${evaluatorId}`)
          .set(bearer(adminToken))
          .send(body);
        expect(rejected.status).toBe(400);
        expect(rejected.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }

      const actions = (await AuditLogModel.find({ 'resource.id': evaluatorId }).lean()).map(
        (entry) => entry.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining(['USER_CREATED', 'ROLE_CHANGED', 'USER_DISABLED', 'USER_ENABLED']),
      );
      assertNoAuthSecrets(await AuditLogModel.find({}).lean(), PASSWORD);
    });

    it('sets mobile number without revoking sessions', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const created = await createPrivilegedUser(app, adminToken, {
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
        mobileNumber: '+919876543210',
      });
      const evaluatorId = created.body.data.id as string;
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const before = await AuthSessionModel.countDocuments({
        userId: evaluatorId,
        revokedAt: null,
      });
      expect(before).toBeGreaterThan(0);

      const updated = await request(app)
        .patch(`/admin/users/${evaluatorId}`)
        .set(bearer(adminToken))
        .send({ mobileNumber: '+919876543211' });
      expect(updated.status).toBe(200);
      expect(updated.body.data.mobileNumber).toBe('+919876543211');

      const after = await AuthSessionModel.countDocuments({
        userId: evaluatorId,
        revokedAt: null,
      });
      expect(after).toBe(before);

      const me = await request(app).get('/auth/me').set(bearer(evaluatorToken));
      expect(me.status).toBe(200);

      const taken = await createPrivilegedUser(app, adminToken, {
        email: 'other-evaluator@example.com',
        role: 'EVALUATOR',
        mobileNumber: '+919811111111',
      });
      const conflict = await request(app)
        .patch(`/admin/users/${evaluatorId}`)
        .set(bearer(adminToken))
        .send({ mobileNumber: '+919811111111' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe(ErrorCodes.MOBILE_NUMBER_ALREADY_REGISTERED);
      expect(taken.body.data.mobileNumber).toBe('+919811111111');

      const audits = await AuditLogModel.find({
        action: 'USER_MOBILE_NUMBER_CHANGED',
        'resource.id': evaluatorId,
      }).lean();
      expect(audits.length).toBeGreaterThan(0);
    });

    it('blocks students, evaluators, and unauthenticated callers', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
      });
      await request(app)
        .post('/auth/register')
        .send({
          email: 'student@example.com',
          password: PASSWORD,
          mobileNumber: nextMobileNumber(),
          name: { first: 'Stu', last: 'Dent' },
        });
      const studentToken = await login(app, 'student@example.com');
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const adminId = await userIdFor('admin@example.com');

      for (const token of [studentToken, evaluatorToken]) {
        const listed = await request(app).get('/admin/users').set(bearer(token));
        expect(listed.status).toBe(403);
        expect(listed.body.error.code).toBe(ErrorCodes.FORBIDDEN);

        const created = await request(app)
          .post('/admin/users')
          .set(bearer(token))
          .send({
            email: 'another@example.com',
            password: PASSWORD,
            role: 'EVALUATOR',
            name: { first: 'A', last: 'B' },
          });
        expect(created.status).toBe(403);
      }

      const unauthenticated = await request(app).get('/admin/users');
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body.error.code).toBe(ErrorCodes.AUTHENTICATION_REQUIRED);

      const unauthenticatedPatch = await request(app)
        .patch(`/admin/users/${adminId}`)
        .send({ status: 'DISABLED' });
      expect(unauthenticatedPatch.status).toBe(401);
    });
  });

  describe('session revocation', () => {
    it('revokes auth sessions on role and status changes so refresh cannot continue', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      const registered = await request(app)
        .post('/auth/register')
        .send({
          email: 'student@example.com',
          password: PASSWORD,
          mobileNumber: nextMobileNumber(),
          name: { first: 'Stu', last: 'Dent' },
        });
      const studentId = registered.body.data.user.id as string;
      const roleCookie = refreshCookie(registered)!;
      const accessToken = registered.body.data.accessToken as string;

      const roleChanged = await request(app)
        .patch(`/admin/users/${studentId}`)
        .set(bearer(adminToken))
        .send({ role: 'EVALUATOR' });
      expect(roleChanged.status).toBe(200);

      const sessionsAfterRole = await AuthSessionModel.find({ userId: studentId }).lean();
      expect(sessionsAfterRole.length).toBeGreaterThan(0);
      expect(sessionsAfterRole.every((session) => session.revokedAt != null)).toBe(true);

      const refreshAfterRole = await request(app)
        .post('/auth/refresh')
        .set('Cookie', roleCookie)
        .set('Origin', 'http://localhost:5173');
      expect(refreshAfterRole.status).toBe(401);
      expect(refreshAfterRole.body.error.code).toBe(ErrorCodes.SESSION_REVOKED);
      expect(JSON.stringify(refreshAfterRole.body)).not.toContain(cookieValue(roleCookie));

      const relogin = await request(app).post('/auth/login').send({
        email: 'student@example.com',
        password: PASSWORD,
      });
      expect(relogin.status).toBe(200);
      const statusCookie = refreshCookie(relogin)!;

      const disabled = await request(app)
        .patch(`/admin/users/${studentId}`)
        .set(bearer(adminToken))
        .send({ status: 'DISABLED' });
      expect(disabled.status).toBe(200);

      const refreshAfterDisable = await request(app)
        .post('/auth/refresh')
        .set('Cookie', statusCookie)
        .set('Origin', 'http://localhost:5173');
      expect(refreshAfterDisable.status).toBe(401);
      expect(refreshAfterDisable.body.error.code).toBe(ErrorCodes.SESSION_REVOKED);

      const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(me.status).toBe(403);
      expect(me.body.error.code).toBe(ErrorCodes.ACCOUNT_DISABLED);

      const loginDisabled = await request(app).post('/auth/login').send({
        email: 'student@example.com',
        password: PASSWORD,
      });
      expect(loginDisabled.status).toBe(401);
      expect(loginDisabled.body.error.code).toBe(ErrorCodes.INVALID_CREDENTIALS);
    });
  });

  describe('evaluator category assignments', () => {
    async function createCategory(app: App, adminToken: string, name: string) {
      const created = await request(app)
        .post('/admin/categories')
        .set(bearer(adminToken))
        .send({ name });
      expect(created.status).toBe(201);
      return created.body.data.id as string;
    }

    it('lets Admin create, list, deactivate, and reactivate assignments without deleting them', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
        name: { first: 'Eva', last: 'Luator' },
      });
      const evaluatorId = await userIdFor('evaluator@example.com');
      const categoryId = await createCategory(app, adminToken, 'Mathematics');

      const created = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId, categoryId });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        evaluatorId,
        categoryId,
        isActive: true,
        evaluator: { email: 'evaluator@example.com', role: 'EVALUATOR' },
        category: { name: 'Mathematics' },
      });
      assertNoAuthSecrets(created.body, PASSWORD);

      const duplicate = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId, categoryId });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe(ErrorCodes.EVALUATOR_CATEGORY_ASSIGNMENT_CONFLICT);

      const listed = await request(app)
        .get('/admin/evaluator-category-assignments')
        .set(bearer(adminToken));
      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.pagination.total).toBe(1);

      const assignmentId = created.body.data.id as string;
      const deactivated = await request(app)
        .patch(`/admin/evaluator-category-assignments/${assignmentId}`)
        .set(bearer(adminToken))
        .send({ isActive: false });
      expect(deactivated.status).toBe(200);
      expect(deactivated.body.data.isActive).toBe(false);
      expect(await EvaluatorCategoryAssignmentModel.countDocuments({})).toBe(1);

      const reactivated = await request(app)
        .patch(`/admin/evaluator-category-assignments/${assignmentId}`)
        .set(bearer(adminToken))
        .send({ isActive: true });
      expect(reactivated.status).toBe(200);
      expect(reactivated.body.data.isActive).toBe(true);
      expect(await EvaluatorCategoryAssignmentModel.countDocuments({})).toBe(1);

      const actions = (
        await AuditLogModel.find({
          'resource.type': 'EvaluatorCategoryAssignment',
        }).lean()
      ).map((entry) => entry.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'EVALUATOR_CATEGORY_ASSIGNED',
          'EVALUATOR_CATEGORY_REMOVED',
          'EVALUATOR_CATEGORY_ACTIVATED',
        ]),
      );
      assertNoAuthSecrets(await AuditLogModel.find({}).lean(), PASSWORD);
    });

    it('filters evaluator-category-assignments by categoryId', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator-a@example.com',
        role: 'EVALUATOR',
      });
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator-b@example.com',
        role: 'EVALUATOR',
      });
      const evaluatorAId = await userIdFor('evaluator-a@example.com');
      const evaluatorBId = await userIdFor('evaluator-b@example.com');
      const mathId = await createCategory(app, adminToken, 'Mathematics');
      const physicsId = await createCategory(app, adminToken, 'Physics');

      const mathAssignment = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId: evaluatorAId, categoryId: mathId });
      expect(mathAssignment.status).toBe(201);

      const physicsAssignment = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId: evaluatorBId, categoryId: physicsId });
      expect(physicsAssignment.status).toBe(201);

      const all = await request(app)
        .get('/admin/evaluator-category-assignments')
        .set(bearer(adminToken));
      expect(all.status).toBe(200);
      expect(all.body.data).toHaveLength(2);

      const mathOnly = await request(app)
        .get(`/admin/evaluator-category-assignments?categoryId=${mathId}`)
        .set(bearer(adminToken));
      expect(mathOnly.status).toBe(200);
      expect(mathOnly.body.data).toHaveLength(1);
      expect(mathOnly.body.data[0]).toMatchObject({
        evaluatorId: evaluatorAId,
        categoryId: mathId,
      });
      expect(mathOnly.body.pagination.total).toBe(1);

      const physicsOnly = await request(app)
        .get(`/admin/evaluator-category-assignments?categoryId=${physicsId}`)
        .set(bearer(adminToken));
      expect(physicsOnly.status).toBe(200);
      expect(physicsOnly.body.data).toHaveLength(1);
      expect(physicsOnly.body.data[0]).toMatchObject({
        evaluatorId: evaluatorBId,
        categoryId: physicsId,
      });

      const invalid = await request(app)
        .get('/admin/evaluator-category-assignments?categoryId=not-an-id')
        .set(bearer(adminToken));
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('filters evaluator-category-assignments by evaluatorId', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator-a@example.com',
        role: 'EVALUATOR',
      });
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator-b@example.com',
        role: 'EVALUATOR',
      });
      const evaluatorAId = await userIdFor('evaluator-a@example.com');
      const evaluatorBId = await userIdFor('evaluator-b@example.com');
      const mathId = await createCategory(app, adminToken, 'Mathematics');

      expect(
        (
          await request(app)
            .post('/admin/evaluator-category-assignments')
            .set(bearer(adminToken))
            .send({ evaluatorId: evaluatorAId, categoryId: mathId })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(app)
            .post('/admin/evaluator-category-assignments')
            .set(bearer(adminToken))
            .send({ evaluatorId: evaluatorBId, categoryId: mathId })
        ).status,
      ).toBe(201);

      const filtered = await request(app)
        .get(`/admin/evaluator-category-assignments?evaluatorId=${evaluatorAId}`)
        .set(bearer(adminToken));
      expect(filtered.status).toBe(200);
      expect(filtered.body.data).toHaveLength(1);
      expect(filtered.body.data[0].evaluatorId).toBe(evaluatorAId);
      expect(filtered.body.pagination.total).toBe(1);
    });

    it('groups assignments by evaluator and paginates evaluators', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator-a@example.com',
        role: 'EVALUATOR',
        name: { first: 'Ann', last: 'Alpha' },
      });
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator-b@example.com',
        role: 'EVALUATOR',
        name: { first: 'Ben', last: 'Beta' },
      });
      const evaluatorAId = await userIdFor('evaluator-a@example.com');
      const evaluatorBId = await userIdFor('evaluator-b@example.com');
      const mathId = await createCategory(app, adminToken, 'Mathematics');
      const physicsId = await createCategory(app, adminToken, 'Physics');

      expect(
        (
          await request(app)
            .post('/admin/evaluator-category-assignments')
            .set(bearer(adminToken))
            .send({ evaluatorId: evaluatorAId, categoryId: mathId })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(app)
            .post('/admin/evaluator-category-assignments')
            .set(bearer(adminToken))
            .send({ evaluatorId: evaluatorAId, categoryId: physicsId })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(app)
            .post('/admin/evaluator-category-assignments')
            .set(bearer(adminToken))
            .send({ evaluatorId: evaluatorBId, categoryId: physicsId })
        ).status,
      ).toBe(201);

      const grouped = await request(app)
        .get('/admin/evaluator-category-assignments/grouped')
        .set(bearer(adminToken));
      expect(grouped.status).toBe(200);
      expect(grouped.body.pagination.total).toBe(2);
      expect(grouped.body.data).toHaveLength(2);
      assertNoAuthSecrets(grouped.body, PASSWORD);

      const groupA = grouped.body.data.find(
        (row: { evaluatorId: string }) => row.evaluatorId === evaluatorAId,
      );
      const groupB = grouped.body.data.find(
        (row: { evaluatorId: string }) => row.evaluatorId === evaluatorBId,
      );
      expect(groupA).toMatchObject({
        evaluatorId: evaluatorAId,
        evaluator: { email: 'evaluator-a@example.com', role: 'EVALUATOR' },
      });
      expect(groupA.assignments).toHaveLength(2);
      expect(groupA.assignments.map((item: { categoryId: string }) => item.categoryId).sort()).toEqual(
        [mathId, physicsId].sort(),
      );
      expect(groupA.assignments[0]).not.toHaveProperty('evaluatorId');
      expect(groupB.assignments).toHaveLength(1);
      expect(groupB.assignments[0].categoryId).toBe(physicsId);

      const page1 = await request(app)
        .get('/admin/evaluator-category-assignments/grouped?page=1&limit=1')
        .set(bearer(adminToken));
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.pagination).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });

      const page2 = await request(app)
        .get('/admin/evaluator-category-assignments/grouped?page=2&limit=1')
        .set(bearer(adminToken));
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page1.body.data[0].evaluatorId).not.toBe(page2.body.data[0].evaluatorId);
    });

    it('filters grouped assignments by membership and returns the evaluator full grant set', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator-a@example.com',
        role: 'EVALUATOR',
      });
      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator-b@example.com',
        role: 'EVALUATOR',
      });
      const evaluatorAId = await userIdFor('evaluator-a@example.com');
      const evaluatorBId = await userIdFor('evaluator-b@example.com');
      const mathId = await createCategory(app, adminToken, 'Mathematics');
      const physicsId = await createCategory(app, adminToken, 'Physics');

      const mathAssignment = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId: evaluatorAId, categoryId: mathId });
      expect(mathAssignment.status).toBe(201);
      expect(
        (
          await request(app)
            .post('/admin/evaluator-category-assignments')
            .set(bearer(adminToken))
            .send({ evaluatorId: evaluatorAId, categoryId: physicsId })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(app)
            .post('/admin/evaluator-category-assignments')
            .set(bearer(adminToken))
            .send({ evaluatorId: evaluatorBId, categoryId: physicsId })
        ).status,
      ).toBe(201);

      const deactivated = await request(app)
        .patch(`/admin/evaluator-category-assignments/${mathAssignment.body.data.id}`)
        .set(bearer(adminToken))
        .send({ isActive: false });
      expect(deactivated.status).toBe(200);

      const mathGroups = await request(app)
        .get(`/admin/evaluator-category-assignments/grouped?categoryId=${mathId}`)
        .set(bearer(adminToken));
      expect(mathGroups.status).toBe(200);
      expect(mathGroups.body.data).toHaveLength(1);
      expect(mathGroups.body.data[0].evaluatorId).toBe(evaluatorAId);
      expect(mathGroups.body.data[0].assignments).toHaveLength(2);

      const evaluatorGroups = await request(app)
        .get(`/admin/evaluator-category-assignments/grouped?evaluatorId=${evaluatorBId}`)
        .set(bearer(adminToken));
      expect(evaluatorGroups.status).toBe(200);
      expect(evaluatorGroups.body.data).toHaveLength(1);
      expect(evaluatorGroups.body.data[0].evaluatorId).toBe(evaluatorBId);
      expect(evaluatorGroups.body.data[0].assignments).toHaveLength(1);

      const inactiveGroups = await request(app)
        .get('/admin/evaluator-category-assignments/grouped?isActive=false')
        .set(bearer(adminToken));
      expect(inactiveGroups.status).toBe(200);
      expect(inactiveGroups.body.data).toHaveLength(1);
      expect(inactiveGroups.body.data[0].evaluatorId).toBe(evaluatorAId);
      expect(inactiveGroups.body.data[0].assignments).toHaveLength(2);

      const invalid = await request(app)
        .get('/admin/evaluator-category-assignments/grouped?isActive=yes')
        .set(bearer(adminToken));
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('rejects assignments to Students, Admins, and missing records', async () => {
      const app = createApp();
      const adminToken = await login(app, 'admin@example.com');
      await request(app)
        .post('/auth/register')
        .send({
          email: 'student@example.com',
          password: PASSWORD,
          mobileNumber: nextMobileNumber(),
          name: { first: 'Stu', last: 'Dent' },
        });
      const studentId = await userIdFor('student@example.com');
      const adminId = await userIdFor('admin@example.com');
      const categoryId = await createCategory(app, adminToken, 'Mathematics');
      const studentToken = await login(app, 'student@example.com');

      const studentAssignment = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId: studentId, categoryId });
      expect(studentAssignment.status).toBe(409);
      expect(studentAssignment.body.error.code).toBe(ErrorCodes.INVALID_PRIVILEGED_ROLE);

      const adminAssignment = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId: adminId, categoryId });
      expect(adminAssignment.status).toBe(409);

      const missingEvaluator = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId: new Types.ObjectId().toString(), categoryId });
      expect(missingEvaluator.status).toBe(404);
      expect(missingEvaluator.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_FOUND);

      await createPrivilegedUser(app, adminToken, {
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
      });
      const evaluatorId = await userIdFor('evaluator@example.com');
      const missingCategory = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(adminToken))
        .send({ evaluatorId, categoryId: new Types.ObjectId().toString() });
      expect(missingCategory.status).toBe(404);
      expect(missingCategory.body.error.code).toBe(ErrorCodes.CATEGORY_NOT_FOUND);

      const studentCreate = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(studentToken))
        .send({ evaluatorId, categoryId });
      expect(studentCreate.status).toBe(403);

      const unauthenticated = await request(app)
        .post('/admin/evaluator-category-assignments')
        .send({ evaluatorId, categoryId });
      expect(unauthenticated.status).toBe(401);
    });
  });

  describe('evaluation authorization integration', () => {
    async function seedEditorCatalog(app: App) {
      const adminToken = await login(app, 'admin@example.com');
      const category = await request(app)
        .post('/admin/categories')
        .set(bearer(adminToken))
        .send({ name: 'Mathematics' });
      const otherCategory = await request(app)
        .post('/admin/categories')
        .set(bearer(adminToken))
        .send({ name: 'Physics' });
      const module = await request(app)
        .post('/admin/modules')
        .set(bearer(adminToken))
        .send({ categoryId: category.body.data.id, name: 'Algebra' });
      const otherModule = await request(app)
        .post('/admin/modules')
        .set(bearer(adminToken))
        .send({ categoryId: otherCategory.body.data.id, name: 'Mechanics' });
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
      const otherEditor = await request(app)
        .post('/admin/test-series')
        .set(bearer(adminToken))
        .send({
          moduleId: otherModule.body.data.id,
          title: 'Physics Editor',
          type: 'EDITOR',
          duration: 3600,
          access: { isFree: false, price: PRICE_PAISE, currency: 'INR' },
        });
      await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: editor.body.data.id,
        position: 1,
        questionText: 'Explain derivatives.',
        content: {},
      });
      await request(app).post('/admin/questions').set(bearer(adminToken)).send({
        testSeriesId: otherEditor.body.data.id,
        position: 1,
        questionText: 'Explain force.',
        content: {},
      });

      return {
        adminToken,
        categoryId: category.body.data.id as string,
        otherCategoryId: otherCategory.body.data.id as string,
        editorId: editor.body.data.id as string,
        otherEditorId: otherEditor.body.data.id as string,
      };
    }

    async function submitEditor(app: App, testSeriesId: string, email: string) {
      const existing = await userRepository.findByEmail(email);
      if (!existing) {
        const registered = await request(app)
          .post('/auth/register')
          .send({
            email,
            password: PASSWORD,
            mobileNumber: nextMobileNumber(),
            name: { first: 'Stu', last: 'Dent' },
          });
        expect(registered.status).toBe(201);
      }
      const studentId = await userIdFor(email);
      const grantedAt = new Date();
      await EntitlementModel.create({
        studentId,
        testSeriesId,
        purchaseId: new Types.ObjectId(),
        status: 'ACTIVE',
        grantedAt,
        expiresAt: addDays(grantedAt, PAID_ENTITLEMENT_VALIDITY_DAYS),
      });
      const studentToken = await login(app, email);
      const started = await request(app)
        .post('/attempts')
        .set(bearer(studentToken))
        .send({ testSeriesId });
      expect(started.status).toBe(201);
      await request(app)
        .patch(`/attempts/${started.body.data.id}/answers`)
        .set(bearer(studentToken))
        .send({ version: 1, editorDocument: { type: 'doc' } });
      const submitted = await request(app)
        .post(`/attempts/${started.body.data.id}/submit`)
        .set(bearer(studentToken));
      expect(submitted.status).toBe(200);
      return submitted.body.data.submissionId as string;
    }

    async function evaluationIdFor(app: App, adminToken: string, submissionId: string) {
      const listed = await request(app).get('/admin/evaluations').set(bearer(adminToken));
      const found = (listed.body.data as Array<{ id: string; submissionId: string }>).find(
        (item) => item.submissionId === submissionId,
      );
      expect(found).toBeTruthy();
      return found!.id;
    }

    it('permits evaluator actions only for an active matching category assignment', async () => {
      const app = createApp();
      const catalog = await seedEditorCatalog(app);
      await createPrivilegedUser(app, catalog.adminToken, {
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
      });
      await createPrivilegedUser(app, catalog.adminToken, {
        email: 'evaluator2@example.com',
        role: 'EVALUATOR',
      });
      const evaluatorId = await userIdFor('evaluator@example.com');
      const otherEvaluatorId = await userIdFor('evaluator2@example.com');
      const evaluatorToken = await login(app, 'evaluator@example.com');
      const otherToken = await login(app, 'evaluator2@example.com');

      const assigned = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId, categoryId: catalog.categoryId });
      expect(assigned.status).toBe(201);
      const assignmentId = assigned.body.data.id as string;

      const otherAssigned = await request(app)
        .post('/admin/evaluator-category-assignments')
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId: otherEvaluatorId, categoryId: catalog.categoryId });
      expect(otherAssigned.status).toBe(201);

      const submissionId = await submitEditor(app, catalog.editorId, 'student@example.com');
      const evaluationId = await evaluationIdFor(app, catalog.adminToken, submissionId);

      const assignedEval = await request(app)
        .post(`/admin/evaluations/${evaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      expect(assignedEval.status).toBe(200);

      const started = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(evaluatorToken));
      expect(started.status).toBe(200);

      const foreign = await request(app)
        .post(`/evaluator/evaluations/${evaluationId}/start`)
        .set(bearer(otherToken));
      expect(foreign.status).toBe(403);
      expect(foreign.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_ASSIGNED);

      const deactivated = await request(app)
        .patch(`/admin/evaluator-category-assignments/${assignmentId}`)
        .set(bearer(catalog.adminToken))
        .send({ isActive: false });
      expect(deactivated.status).toBe(200);

      const denied = await request(app)
        .get(`/evaluator/evaluations/${evaluationId}`)
        .set(bearer(evaluatorToken));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_AUTHORIZED);

      await request(app)
        .patch(`/admin/evaluator-category-assignments/${assignmentId}`)
        .set(bearer(catalog.adminToken))
        .send({ isActive: true });

      const otherSubmissionId = await submitEditor(
        app,
        catalog.otherEditorId,
        'student2@example.com',
      );
      const otherEvaluationId = await evaluationIdFor(app, catalog.adminToken, otherSubmissionId);
      const wrongCategory = await request(app)
        .post(`/admin/evaluations/${otherEvaluationId}/assign`)
        .set(bearer(catalog.adminToken))
        .send({ evaluatorId });
      expect(wrongCategory.status).toBe(403);
      expect(wrongCategory.body.error.code).toBe(ErrorCodes.EVALUATOR_NOT_AUTHORIZED);
    });
  });
});
