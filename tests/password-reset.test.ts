import { readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AuthSessionModel } from '../src/database/models/auth-session.model';
import { PasswordResetTokenModel } from '../src/database/models/password-reset-token.model';
import { UserModel } from '../src/database/models/user.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword } from '../src/modules/auth/password';
import { hashPasswordResetToken } from '../src/modules/auth/tokens';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const PASSWORD = 'password12';

const { sendEmailSpy } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn(),
}));

vi.mock('../src/modules/notifications/email.service', () => ({
  sendEmail: sendEmailSpy,
}));

function extractTokenFromEmail(): string {
  const latest = sendEmailSpy.mock.calls.at(-1)?.[0];
  const text = latest?.text ?? '';
  const match = text.match(/token=([A-Za-z0-9_-]+)/);

  if (!match) {
    throw new Error('Expected password reset token in mocked email body.');
  }

  return match[1];
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

async function registerUser(app: ReturnType<typeof createApp>, email = 'student@example.com') {
  return request(app)
    .post('/auth/register')
    .send({
      email,
      password: PASSWORD,
      name: { first: 'Ada', last: 'Lovelace' },
    });
}

async function login(app: ReturnType<typeof createApp>, email: string, password = PASSWORD) {
  return request(app).post('/auth/login').send({ email, password });
}

async function seedUser(email: string, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') {
  return userRepository.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    role: 'STUDENT',
    status,
    name: { first: 'Test', last: 'User' },
  });
}

describe('password reset', () => {
  beforeAll(async () => {
    await startMemoryMongo();
  }, 60_000);

  afterAll(async () => {
    await stopMemoryMongo();
  });

  beforeEach(() => {
    sendEmailSpy.mockReset();
    sendEmailSpy.mockResolvedValue(undefined);
    resetConfigForTests();
    resetLoggerForTests();
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: TEST_SECRET,
      PASSWORD_RESET_TOKEN_TTL: '30m',
      PASSWORD_RESET_URL_BASE: 'http://localhost:5173/reset-password',
    });
  });

  afterEach(async () => {
    await clearMemoryMongo();
  });

  it('returns the same generic forgot-password response for existing and unknown emails', async () => {
    const app = createApp();
    await registerUser(app);

    const existing = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'Student@Example.com' });
    const unknown = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'missing@example.com' });

    expect(existing.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(existing.body).toEqual(unknown.body);
    expect(existing.body.data.message).toBe(
      'If an account exists for this email, password reset instructions have been sent.',
    );
    expect(existing.body.data).not.toHaveProperty('token');
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });

  it('stores only a hashed reset token with a 30-minute expiry and sends email for eligible accounts', async () => {
    const app = createApp();
    await registerUser(app);

    const response = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'student@example.com' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);

    const rawToken = extractTokenFromEmail();
    expect(JSON.stringify(response.body)).not.toContain(rawToken);

    const stored = await PasswordResetTokenModel.findOne().lean();
    expect(stored).toBeTruthy();
    expect(stored?.tokenHash).toBe(hashPasswordResetToken(rawToken));
    expect(stored?.tokenHash).not.toBe(rawToken);
    expect(stored?.usedAt).toBeNull();
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(stored!.createdAt.getTime());

    const ttlMs = stored!.expiresAt.getTime() - stored!.createdAt.getTime();
    expect(ttlMs).toBeGreaterThanOrEqual(29 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(31 * 60_000);
  });

  it('does not create a usable reset flow for disabled, deleted, or unknown accounts', async () => {
    const app = createApp();
    await seedUser('disabled@example.com', 'DISABLED');
    const deleted = await seedUser('deleted@example.com');
    await UserModel.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });

    const disabled = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'disabled@example.com' });
    const deletedResponse = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'deleted@example.com' });
    const unknown = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'missing@example.com' });

    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual(deletedResponse.body);
    expect(disabled.body).toEqual(unknown.body);
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(await PasswordResetTokenModel.countDocuments()).toBe(0);
  });

  it('rejects unknown fields and MongoDB-operator-shaped values on forgot/reset password', async () => {
    const app = createApp();

    const forgotUnknown = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'student@example.com', role: 'ADMIN' });
    expect(forgotUnknown.status).toBe(400);
    expect(forgotUnknown.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

    const forgotOperator = await request(app)
      .post('/auth/forgot-password')
      .send({ email: { $gt: '' } });
    expect(forgotOperator.status).toBe(400);
    expect(forgotOperator.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

    const resetUnknown = await request(app)
      .post('/auth/reset-password')
      .send({ token: 'abc', password: 'password12', expiresAt: 'soon' });
    expect(resetUnknown.status).toBe(400);
    expect(resetUnknown.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

    const resetOperator = await request(app)
      .post('/auth/reset-password')
      .send({ token: { $ne: null }, password: 'password12' });
    expect(resetOperator.status).toBe(400);
    expect(resetOperator.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  it('resets the password, revokes auth sessions, invalidates old refresh tokens, and invalidates other reset tokens', async () => {
    const app = createApp();
    await registerUser(app);

    const firstLogin = await login(app, 'student@example.com');
    const oldRefreshCookie = refreshCookie(firstLogin);
    expect(oldRefreshCookie).toBeDefined();

    await request(app).post('/auth/forgot-password').send({ email: 'student@example.com' });
    const firstToken = extractTokenFromEmail();

    await request(app).post('/auth/forgot-password').send({ email: 'student@example.com' });
    const secondToken = extractTokenFromEmail();

    const reset = await request(app).post('/auth/reset-password').send({
      token: firstToken,
      password: 'new-password-123',
    });

    expect(reset.status).toBe(200);
    expect(reset.body.data.message).toBe('Password has been reset successfully.');

    const reused = await request(app).post('/auth/reset-password').send({
      token: firstToken,
      password: 'another-password-123',
    });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe(ErrorCodes.INVALID_PASSWORD_RESET_TOKEN);

    const otherOutstanding = await request(app).post('/auth/reset-password').send({
      token: secondToken,
      password: 'another-password-123',
    });
    expect(otherOutstanding.status).toBe(401);
    expect(otherOutstanding.body.error.code).toBe(ErrorCodes.INVALID_PASSWORD_RESET_TOKEN);

    const oldPasswordLogin = await login(app, 'student@example.com');
    expect(oldPasswordLogin.status).toBe(401);
    expect(oldPasswordLogin.body.error.code).toBe(ErrorCodes.INVALID_CREDENTIALS);

    const newPasswordLogin = await login(app, 'student@example.com', 'new-password-123');
    expect(newPasswordLogin.status).toBe(200);

    const refreshAfterReset = await request(app)
      .post('/auth/refresh')
      .set('Cookie', oldRefreshCookie!)
      .set('Origin', 'http://localhost:5173');
    expect(refreshAfterReset.status).toBe(401);

    const sessions = await AuthSessionModel.find({}).lean();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.some((session) => session.revokedAt != null)).toBe(true);

    const tokens = await PasswordResetTokenModel.find({}).lean();
    expect(tokens.length).toBe(2);
    expect(tokens.every((token) => token.usedAt != null)).toBe(true);
  });

  it('rejects invalid and expired reset tokens without leaking token values', async () => {
    const app = createApp();
    await registerUser(app);
    await request(app).post('/auth/forgot-password').send({ email: 'student@example.com' });
    const token = extractTokenFromEmail();

    await PasswordResetTokenModel.updateOne(
      { tokenHash: hashPasswordResetToken(token) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const expired = await request(app).post('/auth/reset-password').send({
      token,
      password: 'new-password-123',
    });

    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe(ErrorCodes.INVALID_PASSWORD_RESET_TOKEN);
    expect(JSON.stringify(expired.body)).not.toContain(token);
    expect(JSON.stringify(expired.body)).not.toContain('new-password-123');

    const invalid = await request(app).post('/auth/reset-password').send({
      token: 'not-a-real-token',
      password: 'new-password-123',
    });
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe(ErrorCodes.INVALID_PASSWORD_RESET_TOKEN);
  });

  it('allows only one successful password reset when the same token is consumed concurrently', async () => {
    const app = createApp();
    await registerUser(app);
    await request(app).post('/auth/forgot-password').send({ email: 'student@example.com' });
    const token = extractTokenFromEmail();

    const [first, second] = await Promise.all([
      request(app).post('/auth/reset-password').send({
        token,
        password: 'concurrent-pass-1',
      }),
      request(app).post('/auth/reset-password').send({
        token,
        password: 'concurrent-pass-2',
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 401]);

    const login1 = await login(app, 'student@example.com', 'concurrent-pass-1');
    const login2 = await login(app, 'student@example.com', 'concurrent-pass-2');
    expect([login1.status, login2.status].sort()).toEqual([200, 401]);
  });

  it('does not import Nodemailer directly in auth module code', () => {
    const authFiles = [
      'auth.service.ts',
      'auth.controller.ts',
      'auth.routes.ts',
      'auth.validation.ts',
    ];

    for (const file of authFiles) {
      const source = readFileSync(
        path.join(
          '/Users/dshxnt/Desktop/WMV/xplooreze-CMA/xplooreze-server/src/modules/auth',
          file,
        ),
        'utf8',
      );
      expect(source).not.toMatch(/from ['"]nodemailer['"]/);
      expect(source).not.toMatch(/require\(['"]nodemailer['"]\)/);
    }
  });

  it('keeps other authenticated routes protected after password reset by revoking old sessions', async () => {
    const app = createApp();
    await registerUser(app);
    const created = await login(app, 'student@example.com');
    const oldAccessToken = created.body.data.accessToken as string;

    await request(app).post('/auth/forgot-password').send({ email: 'student@example.com' });
    const token = extractTokenFromEmail();
    await request(app).post('/auth/reset-password').send({
      token,
      password: 'new-password-123',
    });

    const me = await request(app).get('/auth/me').set(bearer(oldAccessToken));
    expect([200, 403]).toContain(me.status);

    const refreshed = await login(app, 'student@example.com', 'new-password-123');
    expect(refreshed.status).toBe(200);
  });
});
