import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resetConfigForTests } from '../src/config/index';
import { errorHandler } from '../src/middleware/error-handler';
import { requireAdmin, requireEvaluator, requireStudent } from '../src/middleware/require-role';
import { normalizeEmail } from '../src/modules/auth/email';
import { hashPassword, verifyPassword } from '../src/modules/auth/password';
import { hashRefreshToken, issueAccessToken, verifyAccessToken } from '../src/modules/auth/tokens';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { getLogger, resetLoggerForTests } from '../src/shared/logger/logger';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';

function loadAuthTestConfig(overrides: Record<string, string> = {}) {
  resetConfigForTests();
  resetLoggerForTests();
  loadConfig({
    NODE_ENV: 'test',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    CORS_ORIGIN: 'http://localhost:5173',
    JWT_SECRET: TEST_SECRET,
    ...overrides,
  });
}

describe('email normalization', () => {
  it('trims and lowercases email addresses', () => {
    expect(normalizeEmail('John.Doe@Example.com ')).toBe('john.doe@example.com');
  });
});

describe('password hashing', () => {
  it('hashes passwords with Argon2 and never stores plaintext', async () => {
    const password = 'correct-horse-battery';
    const hash = await hashPassword(password);

    expect(hash).not.toBe(password);
    expect(hash.startsWith('$argon2')).toBe(true);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-password')).resolves.toBe(false);
  });
});

describe('access tokens', () => {
  beforeEach(() => {
    loadAuthTestConfig();
  });

  it('issues and verifies access tokens with required claims', () => {
    const token = issueAccessToken({
      sub: '507f1f77bcf86cd799439011',
      role: 'STUDENT',
      sessionId: '507f1f77bcf86cd799439012',
    });

    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe('507f1f77bcf86cd799439011');
    expect(claims.role).toBe('STUDENT');
    expect(claims.type).toBe('access');
    expect(claims.sessionId).toBe('507f1f77bcf86cd799439012');
  });

  it('rejects expired, wrongly signed, and invalid-claim tokens', () => {
    const expired = jwt.sign(
      {
        sub: '507f1f77bcf86cd799439011',
        role: 'STUDENT',
        type: 'access',
        sessionId: '507f1f77bcf86cd799439012',
        exp: Math.floor(Date.now() / 1000) - 30,
      },
      TEST_SECRET,
      { issuer: 'xplooreze', audience: 'xplooreze-api' },
    );

    expect(() => verifyAccessToken(expired)).toThrowError(/expired/i);

    const wrongSecret = jwt.sign(
      {
        sub: '507f1f77bcf86cd799439011',
        role: 'STUDENT',
        type: 'access',
        sessionId: '507f1f77bcf86cd799439012',
      },
      'another-secret-that-is-at-least-32-chars',
      { expiresIn: '15m', issuer: 'xplooreze', audience: 'xplooreze-api' },
    );

    try {
      verifyAccessToken(wrongSecret);
      expect.unreachable('expected invalid signature to fail');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 401, code: ErrorCodes.INVALID_TOKEN });
    }

    const missingClaims = jwt.sign(
      { sub: '507f1f77bcf86cd799439011', type: 'refresh' },
      TEST_SECRET,
      { expiresIn: '15m', issuer: 'xplooreze', audience: 'xplooreze-api' },
    );

    try {
      verifyAccessToken(missingClaims);
      expect.unreachable('expected invalid claims to fail');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 401, code: ErrorCodes.INVALID_TOKEN });
    }
  });

  it('hashes refresh tokens instead of storing them raw', () => {
    const token = 'refresh-token-value';
    const hash = hashRefreshToken(token);
    expect(hash).not.toBe(token);
    expect(hash).toHaveLength(64);
  });
});

describe('role authorization helpers', () => {
  beforeEach(() => {
    loadAuthTestConfig();
  });

  function roleApp() {
    const app = express();
    app.get(
      '/student',
      (req, _res, next) => {
        req.auth = { userId: 'u1', role: 'STUDENT', sessionId: 's1' };
        next();
      },
      requireStudent,
      (_req, res) => {
        res.json({ ok: true, role: 'STUDENT' });
      },
    );
    app.get(
      '/evaluator',
      (req, _res, next) => {
        req.auth = { userId: 'u2', role: 'EVALUATOR', sessionId: 's2' };
        next();
      },
      requireEvaluator,
      (_req, res) => {
        res.json({ ok: true, role: 'EVALUATOR' });
      },
    );
    app.get(
      '/admin',
      (req, _res, next) => {
        req.auth = { userId: 'u3', role: 'ADMIN', sessionId: 's3' };
        next();
      },
      requireAdmin,
      (_req, res) => {
        res.json({ ok: true, role: 'ADMIN' });
      },
    );
    app.get(
      '/admin-as-student',
      (req, _res, next) => {
        req.auth = { userId: 'u1', role: 'STUDENT', sessionId: 's1' };
        next();
      },
      requireAdmin,
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.get('/unauthenticated', requireAdmin, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    return app;
  }

  it('allows matching roles and rejects mismatches or missing auth', async () => {
    const app = roleApp();

    await expect(request(app).get('/student')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, role: 'STUDENT' },
    });
    await expect(request(app).get('/evaluator')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, role: 'EVALUATOR' },
    });
    await expect(request(app).get('/admin')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, role: 'ADMIN' },
    });

    const mismatch = await request(app).get('/admin-as-student');
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe(ErrorCodes.FORBIDDEN);

    const unauthenticated = await request(app).get('/unauthenticated');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe(ErrorCodes.AUTHENTICATION_REQUIRED);
  });
});

describe('log redaction', () => {
  beforeEach(() => {
    loadAuthTestConfig();
  });

  it('redacts password and token bindings', () => {
    const logger = getLogger({
      password: 'plain-password',
      token: 'access-or-refresh-token',
      jwtSecret: TEST_SECRET,
    });

    expect(JSON.stringify(logger.bindings())).not.toContain('plain-password');
    expect(JSON.stringify(logger.bindings())).not.toContain('access-or-refresh-token');
    expect(JSON.stringify(logger.bindings())).not.toContain(TEST_SECRET);
  });
});
