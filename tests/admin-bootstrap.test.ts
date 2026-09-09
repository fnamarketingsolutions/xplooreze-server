import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { UserModel } from '../src/database/models/user.model';
import { userRepository } from '../src/database/repositories/user.repository';
import { hashPassword, verifyPassword } from '../src/modules/auth/password';
import {
  readAdminBootstrapCredentials,
  seedFirstAdmin,
} from '../src/modules/users/admin-bootstrap';
import * as loggerModule from '../src/shared/logger/logger';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const PASSWORD = 'bootstrap-password-12';
const OTHER_PASSWORD = 'other-bootstrap-99';
const ROOT = process.cwd();

const bootstrapEnv = {
  ADMIN_BOOTSTRAP_EMAIL: 'admin@example.com',
  ADMIN_BOOTSTRAP_PASSWORD: PASSWORD,
  ADMIN_BOOTSTRAP_FIRST_NAME: 'Ada',
  ADMIN_BOOTSTRAP_LAST_NAME: 'Admin',
  ADMIN_BOOTSTRAP_MOBILE_NUMBER: '+919876543210',
};

function credentials(overrides: Record<string, string> = {}) {
  return readAdminBootstrapCredentials({ ...bootstrapEnv, ...overrides });
}

describe('Phase 12 first Admin bootstrap', () => {
  beforeAll(async () => {
    await startMemoryMongo();
  }, 60_000);

  afterAll(async () => {
    await stopMemoryMongo();
  });

  beforeEach(() => {
    resetConfigForTests();
    loggerModule.resetLoggerForTests();
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMemoryMongo();
  });

  it('reads credentials from environment variables and rejects missing or invalid values', () => {
    const parsed = credentials();
    expect(parsed).toEqual({
      email: 'admin@example.com',
      password: PASSWORD,
      mobileNumber: '+919876543210',
      name: { first: 'Ada', last: 'Admin' },
    });

    expect(() => readAdminBootstrapCredentials({})).toThrow(
      'Missing required environment variable: ADMIN_BOOTSTRAP_EMAIL',
    );
    expect(() =>
      readAdminBootstrapCredentials({ ADMIN_BOOTSTRAP_EMAIL: 'admin@example.com' }),
    ).toThrow('Missing required environment variable: ADMIN_BOOTSTRAP_PASSWORD');

    const leaked = 'super-secret-bootstrap-password';
    try {
      readAdminBootstrapCredentials({
        ADMIN_BOOTSTRAP_EMAIL: 'not-an-email',
        ADMIN_BOOTSTRAP_PASSWORD: leaked,
        ADMIN_BOOTSTRAP_FIRST_NAME: 'Ada',
        ADMIN_BOOTSTRAP_LAST_NAME: 'Admin',
        ADMIN_BOOTSTRAP_MOBILE_NUMBER: '+919876543210',
      });
      throw new Error('expected invalid email to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(leaked);
      expect((error as Error).message).toBe('Invalid ADMIN_BOOTSTRAP_EMAIL.');
    }
  });

  it('requires a mobile number only when creating the first Admin', async () => {
    const withoutMobile = readAdminBootstrapCredentials({
      ADMIN_BOOTSTRAP_EMAIL: 'admin@example.com',
      ADMIN_BOOTSTRAP_PASSWORD: PASSWORD,
      ADMIN_BOOTSTRAP_FIRST_NAME: 'Ada',
      ADMIN_BOOTSTRAP_LAST_NAME: 'Admin',
    });

    await expect(seedFirstAdmin(withoutMobile)).rejects.toThrow(
      'Missing required environment variable: ADMIN_BOOTSTRAP_MOBILE_NUMBER',
    );

    const created = await seedFirstAdmin(credentials());
    expect(created.created).toBe(true);

    const again = await seedFirstAdmin(withoutMobile);
    expect(again.created).toBe(false);
    expect(again.userId).toBe(created.userId);
  });

  it('creates the first Admin with a hashed password from environment credentials', async () => {
    const info = vi.fn();
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue({
      info,
      error: vi.fn(),
    } as never);

    const result = await seedFirstAdmin(credentials());
    expect(result.created).toBe(true);

    const stored = await UserModel.findById(result.userId).lean();
    expect(stored).toMatchObject({
      email: 'admin@example.com',
      role: 'ADMIN',
      status: 'ACTIVE',
      mobileNumber: '+919876543210',
      name: { first: 'Ada', last: 'Admin' },
      deletedAt: null,
    });
    expect(stored?.passwordHash).toBeDefined();
    expect(stored?.passwordHash).not.toBe(PASSWORD);
    expect(stored?.passwordHash.startsWith('$argon2')).toBe(true);
    await expect(verifyPassword(stored!.passwordHash, PASSWORD)).resolves.toBe(true);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(info.mock.calls)).not.toContain(PASSWORD);
  });

  it('is idempotent and does not overwrite an existing Admin or create a duplicate', async () => {
    const first = await seedFirstAdmin(credentials());
    const original = await UserModel.findById(first.userId).lean();

    const second = await seedFirstAdmin(credentials({ ADMIN_BOOTSTRAP_PASSWORD: OTHER_PASSWORD }));
    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(await UserModel.countDocuments({ role: 'ADMIN' })).toBe(1);

    const unchanged = await UserModel.findById(first.userId).lean();
    expect(unchanged?.passwordHash).toBe(original?.passwordHash);
    await expect(verifyPassword(unchanged!.passwordHash, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(unchanged!.passwordHash, OTHER_PASSWORD)).resolves.toBe(false);

    const third = await seedFirstAdmin(
      credentials({
        ADMIN_BOOTSTRAP_EMAIL: 'other-admin@example.com',
        ADMIN_BOOTSTRAP_PASSWORD: OTHER_PASSWORD,
      }),
    );
    expect(third.created).toBe(false);
    expect(third.userId).toBe(first.userId);
    expect(await UserModel.countDocuments({})).toBe(1);
  });

  it('does not promote a non-Admin account that already owns the bootstrap email', async () => {
    await userRepository.create({
      email: 'admin@example.com',
      passwordHash: await hashPassword('student-password-12'),
      role: 'STUDENT',
      status: 'ACTIVE',
      name: { first: 'Stu', last: 'Dent' },
    });

    await expect(seedFirstAdmin(credentials())).rejects.toThrow(
      'An account with this email already exists.',
    );
    const stored = await UserModel.findOne({ email: 'admin@example.com' }).lean();
    expect(stored?.role).toBe('STUDENT');
    expect(await UserModel.countDocuments({ role: 'ADMIN' })).toBe(0);
  });

  it('is not invoked by application startup, start, or test scripts', async () => {
    createApp();
    expect(await UserModel.countDocuments({})).toBe(0);

    const serverSrc = readFileSync(path.join(ROOT, 'src/server.ts'), 'utf8');
    const appSrc = readFileSync(path.join(ROOT, 'src/app.ts'), 'utf8');
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(serverSrc).not.toMatch(/seedFirstAdmin|seed-admin|seed:admin/);
    expect(appSrc).not.toMatch(/seedFirstAdmin|seed-admin|seed:admin/);
    expect(pkg.scripts.start).not.toMatch(/seed/);
    expect(pkg.scripts.dev).not.toMatch(/seed/);
    expect(pkg.scripts.test).not.toMatch(/seed/);
    expect(pkg.scripts['seed:admin']).toBe('tsx src/scripts/seed-admin.ts');
  });
});
