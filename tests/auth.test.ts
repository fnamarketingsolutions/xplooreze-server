import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AuthSessionModel } from '../src/database/models/auth-session.model';
import { UserModel } from '../src/database/models/user.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { authenticate } from '../src/middleware/authenticate';
import { errorHandler } from '../src/middleware/error-handler';
import { requireAdmin, requireEvaluator, requireStudent } from '../src/middleware/require-role';
import { hashPassword } from '../src/modules/auth/password';
import { hashRefreshToken } from '../src/modules/auth/tokens';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';

const registerBody = {
  email: 'student@example.com',
  password: PASSWORD,
  name: { first: 'Ada', last: 'Lovelace' },
};

function cookieValue(setCookie: string): string {
  return setCookie.split(';', 1)[0]?.split('=').slice(1).join('=') ?? '';
}

function refreshCookie(response: request.Response): string | undefined {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  return cookies.find((entry) => entry.startsWith('refresh_token='));
}

describe('authentication API', () => {
  beforeAll(async () => {
    await startMemoryMongo();
  }, 60_000);

  afterAll(async () => {
    await stopMemoryMongo();
  });

  beforeEach(() => {
    resetConfigForTests();
    resetLoggerForTests();
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: TEST_SECRET,
    });
  });

  afterEach(async () => {
    await clearMemoryMongo();
  });

  it('registers a student, hashes the password, and omits secrets from the response', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/auth/register')
      .send({
        ...registerBody,
        email: '  John.Doe@Example.com ',
        role: 'ADMIN',
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.user).toMatchObject({
      email: 'john.doe@example.com',
      role: 'STUDENT',
      status: 'ACTIVE',
      name: { first: 'Ada', last: 'Lovelace' },
    });
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.user).not.toHaveProperty('password');
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
    expect(response.body.data).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);

    const cookie = refreshCookie(response);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(JSON.stringify(response.body)).not.toContain(cookieValue(cookie!));

    const stored = await UserModel.findOne({ email: 'john.doe@example.com' }).lean();
    expect(stored?.passwordHash).toBeDefined();
    expect(stored?.passwordHash).not.toBe(PASSWORD);
    expect(stored?.passwordHash.startsWith('$argon2')).toBe(true);
    expect(stored?.role).toBe('STUDENT');
  });

  it('rejects invalid registration input and duplicate active emails', async () => {
    const app = createApp();

    const invalidEmail = await request(app)
      .post('/auth/register')
      .send({ ...registerBody, email: 'not-an-email' });
    expect(invalidEmail.status).toBe(400);
    expect(invalidEmail.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

    const invalidPassword = await request(app)
      .post('/auth/register')
      .send({ ...registerBody, password: 'short' });
    expect(invalidPassword.status).toBe(400);
    expect(invalidPassword.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

    await request(app).post('/auth/register').send(registerBody);
    const duplicate = await request(app).post('/auth/register').send(registerBody);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe(ErrorCodes.EMAIL_ALREADY_REGISTERED);
  });

  it('logs in with valid credentials and issues an access token plus refresh cookie', async () => {
    const app = createApp();
    await request(app).post('/auth/register').send(registerBody);

    const response = await request(app).post('/auth/login').send({
      email: 'student@example.com',
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.user.email).toBe('student@example.com');
    expect(response.body.data).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);

    const cookie = refreshCookie(response);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(JSON.stringify(response.body)).not.toContain(cookieValue(cookie!));
  });

  it('uses the same login error for invalid credentials and disabled users', async () => {
    const app = createApp();
    await request(app).post('/auth/register').send(registerBody);

    const invalid = await request(app).post('/auth/login').send({
      email: 'student@example.com',
      password: 'wrong-password',
    });
    const unknown = await request(app).post('/auth/login').send({
      email: 'missing@example.com',
      password: PASSWORD,
    });

    await UserModel.updateOne({ email: 'student@example.com' }, { $set: { status: 'DISABLED' } });
    const disabled = await request(app).post('/auth/login').send({
      email: 'student@example.com',
      password: PASSWORD,
    });

    for (const response of [invalid, unknown, disabled]) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCodes.INVALID_CREDENTIALS);
      expect(response.body.error.message).toBe('Invalid email or password.');
      expect(refreshCookie(response)).toBeUndefined();
      expect(response.body.data).toBeUndefined();
    }
  });

  it('accepts a valid access token on /auth/me and rejects missing, malformed, expired, and invalid tokens', async () => {
    const app = createApp();
    const created = await request(app).post('/auth/register').send(registerBody);
    const accessToken = created.body.data.accessToken as string;

    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user).toMatchObject({
      email: 'student@example.com',
      role: 'STUDENT',
    });
    expect(me.body.data.user).not.toHaveProperty('passwordHash');

    const missing = await request(app).get('/auth/me');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe(ErrorCodes.AUTHENTICATION_REQUIRED);

    const malformed = await request(app).get('/auth/me').set('Authorization', 'Bearer not-a-jwt');
    expect(malformed.status).toBe(401);
    expect(malformed.body.error.code).toBe(ErrorCodes.INVALID_TOKEN);

    const expired = jwt.sign(
      {
        sub: created.body.data.user.id,
        role: 'STUDENT',
        type: 'access',
        sessionId: '507f1f77bcf86cd799439012',
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      TEST_SECRET,
      { issuer: 'xplooreze', audience: 'xplooreze-api' },
    );
    const expiredResponse = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(expiredResponse.status).toBe(401);
    expect(expiredResponse.body.error.code).toBe(ErrorCodes.TOKEN_EXPIRED);

    const badSignature = jwt.sign(
      {
        sub: created.body.data.user.id,
        role: 'STUDENT',
        type: 'access',
        sessionId: '507f1f77bcf86cd799439012',
      },
      'another-secret-that-is-at-least-32-chars',
      { expiresIn: '15m', issuer: 'xplooreze', audience: 'xplooreze-api' },
    );
    const badSignatureResponse = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${badSignature}`);
    expect(badSignatureResponse.status).toBe(401);
    expect(badSignatureResponse.body.error.code).toBe(ErrorCodes.INVALID_TOKEN);

    const invalidClaims = jwt.sign(
      { sub: created.body.data.user.id, role: 'STUDENT', type: 'refresh' },
      TEST_SECRET,
      { expiresIn: '15m', issuer: 'xplooreze', audience: 'xplooreze-api' },
    );
    const invalidClaimsResponse = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${invalidClaims}`);
    expect(invalidClaimsResponse.status).toBe(401);
    expect(invalidClaimsResponse.body.error.code).toBe(ErrorCodes.INVALID_TOKEN);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const app = createApp();
    const created = await request(app).post('/auth/register').send(registerBody);
    const firstCookie = refreshCookie(created);
    expect(firstCookie).toBeDefined();

    const refreshed = await request(app)
      .post('/auth/refresh')
      .set('Cookie', firstCookie!)
      .set('Origin', 'http://localhost:5173');

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshed.body.data.accessToken).not.toBe(created.body.data.accessToken);
    expect(refreshed.body.data).not.toHaveProperty('refreshToken');

    const secondCookie = refreshCookie(refreshed);
    expect(secondCookie).toBeDefined();
    expect(cookieValue(secondCookie!)).not.toBe(cookieValue(firstCookie!));

    const firstHash = hashRefreshToken(cookieValue(firstCookie!));
    const previous = await AuthSessionModel.findOne({ refreshTokenHash: firstHash }).lean();
    expect(previous?.revokedAt).toBeTruthy();

    const reuse = await request(app)
      .post('/auth/refresh')
      .set('Cookie', firstCookie!)
      .set('Origin', 'http://localhost:5173');

    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe(ErrorCodes.SESSION_REVOKED);
    expect(reuse.body.data).toBeUndefined();

    const afterReuse = await request(app)
      .post('/auth/refresh')
      .set('Cookie', secondCookie!)
      .set('Origin', 'http://localhost:5173');
    expect(afterReuse.status).toBe(401);

    const family = await AuthSessionModel.find({ familyId: previous?.familyId }).lean();
    expect(family.every((session) => session.revokedAt != null)).toBe(true);
  });

  it('rejects missing, malformed, and expired refresh tokens', async () => {
    const app = createApp();
    const created = await request(app).post('/auth/register').send(registerBody);
    const cookie = refreshCookie(created)!;

    const missing = await request(app).post('/auth/refresh').set('Origin', 'http://localhost:5173');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe(ErrorCodes.INVALID_REFRESH_TOKEN);

    const malformed = await request(app)
      .post('/auth/refresh')
      .set('Cookie', 'refresh_token=not-a-valid-session')
      .set('Origin', 'http://localhost:5173');
    expect(malformed.status).toBe(401);
    expect(malformed.body.error.code).toBe(ErrorCodes.INVALID_REFRESH_TOKEN);

    await AuthSessionModel.updateOne(
      { refreshTokenHash: hashRefreshToken(cookieValue(cookie)) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const expired = await request(app)
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173');
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe(ErrorCodes.INVALID_REFRESH_TOKEN);
  });

  it('revokes the session and clears the refresh cookie on logout', async () => {
    const app = createApp();
    const created = await request(app).post('/auth/register').send(registerBody);
    const cookie = refreshCookie(created)!;

    const loggedOut = await request(app)
      .post('/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173');

    expect(loggedOut.status).toBe(200);
    const cleared = refreshCookie(loggedOut);
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Max-Age=0|Expires=/i);

    const stored = await AuthSessionModel.findOne({
      refreshTokenHash: hashRefreshToken(cookieValue(cookie)),
    }).lean();
    expect(stored?.revokedAt).toBeTruthy();

    const refreshAfterLogout = await request(app)
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173');
    expect(refreshAfterLogout.status).toBe(401);
  });

  it('stops disabled users from using an existing session indefinitely', async () => {
    const app = createApp();
    const created = await request(app).post('/auth/register').send(registerBody);
    const accessToken = created.body.data.accessToken as string;
    const cookie = refreshCookie(created)!;

    await UserModel.updateOne({ email: 'student@example.com' }, { $set: { status: 'DISABLED' } });

    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe(ErrorCodes.ACCOUNT_DISABLED);

    const refreshed = await request(app)
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173');
    expect(refreshed.status).toBe(401);
    expect(refreshed.body.data).toBeUndefined();
  });

  it('authorizes Student, Evaluator, and Admin role helpers through authenticated identity', async () => {
    const app = createApp();
    await request(app).post('/auth/register').send(registerBody);

    await userRepository.create({
      email: 'evaluator@example.com',
      passwordHash: await hashPassword(PASSWORD),
      role: 'EVALUATOR',
      status: 'ACTIVE',
      name: { first: 'Eve', last: 'Evaluator' },
    });
    await userRepository.create({
      email: 'admin@example.com',
      passwordHash: await hashPassword(PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
      name: { first: 'Ann', last: 'Admin' },
    });

    const student = await request(app).post('/auth/login').send({
      email: 'student@example.com',
      password: PASSWORD,
    });
    const evaluator = await request(app).post('/auth/login').send({
      email: 'evaluator@example.com',
      password: PASSWORD,
    });
    const admin = await request(app).post('/auth/login').send({
      email: 'admin@example.com',
      password: PASSWORD,
    });

    const studentMe = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${student.body.data.accessToken}`);
    const evaluatorMe = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${evaluator.body.data.accessToken}`);
    const adminMe = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${admin.body.data.accessToken}`);

    expect(studentMe.body.data.user.role).toBe('STUDENT');
    expect(evaluatorMe.body.data.user.role).toBe('EVALUATOR');
    expect(adminMe.body.data.user.role).toBe('ADMIN');

    const rbac = express();
    rbac.get('/student', authenticate, requireStudent, (_req, res) => {
      res.json({ ok: true });
    });
    rbac.get('/evaluator', authenticate, requireEvaluator, (_req, res) => {
      res.json({ ok: true });
    });
    rbac.get('/admin', authenticate, requireAdmin, (_req, res) => {
      res.json({ ok: true });
    });
    rbac.use(errorHandler);

    const studentToken = student.body.data.accessToken as string;
    const evaluatorToken = evaluator.body.data.accessToken as string;
    const adminToken = admin.body.data.accessToken as string;

    expect(
      (await request(rbac).get('/student').set('Authorization', `Bearer ${studentToken}`)).status,
    ).toBe(200);
    expect(
      (await request(rbac).get('/evaluator').set('Authorization', `Bearer ${evaluatorToken}`))
        .status,
    ).toBe(200);
    expect(
      (await request(rbac).get('/admin').set('Authorization', `Bearer ${adminToken}`)).status,
    ).toBe(200);

    expect(
      (await request(rbac).get('/admin').set('Authorization', `Bearer ${studentToken}`)).status,
    ).toBe(403);
    expect(
      (await request(rbac).get('/student').set('Authorization', `Bearer ${adminToken}`)).status,
    ).toBe(403);
    expect((await request(rbac).get('/admin')).status).toBe(401);
  });
});
