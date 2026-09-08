import { afterEach, describe, expect, it } from 'vitest';

import { loadEnvConfig } from '../src/config/env';
import { loadBlobConfig, requireBlobConfig } from '../src/config/blob';
import { loadDatabaseConfig, requireDatabaseConfig } from '../src/config/database';
import { loadEmailConfig, requireEmailConfig } from '../src/config/email';
import { loadRazorpayConfig, requireRazorpayConfig } from '../src/config/razorpay';
import { loadAuthConfig, requireAuthConfig } from '../src/config/auth';
import { loadConfig, resetConfigForTests } from '../src/config/index';

describe('configuration', () => {
  afterEach(() => {
    resetConfigForTests();
  });

  it('accepts valid always-required application configuration', () => {
    const env = loadEnvConfig({
      NODE_ENV: 'development',
      PORT: '4000',
      LOG_LEVEL: 'info',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    expect(env).toEqual({
      nodeEnv: 'development',
      port: 4000,
      logLevel: 'info',
      corsOrigin: ['http://localhost:5173'],
    });
  });

  it('defaults PORT to 5010 when unset', () => {
    const env = loadEnvConfig({
      NODE_ENV: 'development',
    });

    expect(env.port).toBe(5010);
  });

  it('loads integration configuration as optional at boot', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    expect(config.database.uri).toBeUndefined();
    expect(config.blob.readWriteToken).toBeUndefined();
    expect(config.blob.access).toBe('private');
    expect(config.blob.uploadUrlTtlSeconds).toBe(300);
    expect(config.blob.downloadUrlTtlSeconds).toBe(60);
    expect(config.razorpay.keyId).toBeUndefined();
    expect(config.auth.jwtSecret).toBeUndefined();
    expect(config.email.smtpHost).toBeUndefined();
    expect(config.email.smtpPort).toBe(587);
    expect(config.email.smtpSecure).toBe(false);
    expect(config.auth.accessTokenTtl).toBe('15m');
    expect(config.auth.refreshTokenTtl).toBe('7d');
    expect(config.auth.passwordResetTokenTtl).toBe('30m');
    expect(config.auth.passwordResetUrlBase).toBeUndefined();
    expect(config.auth.cookie).toEqual({
      name: 'refresh_token',
      path: '/auth',
      sameSite: 'lax',
      secure: false,
    });
  });

  it('loads sender and SMTP configuration lazily', () => {
    const config = loadEmailConfig({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USERNAME: 'mailer-user',
      SMTP_PASSWORD: 'mailer-password',
      SMTP_FROM_EMAIL: 'no-reply@example.com',
      SMTP_FROM_NAME: 'Xplooreze',
    });

    expect(config).toEqual({
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
      smtpUsername: 'mailer-user',
      smtpPassword: 'mailer-password',
      fromEmail: 'no-reply@example.com',
      fromName: 'Xplooreze',
    });
  });

  it('requires SMTP configuration only when the email integration is initialized', () => {
    expect(() => requireEmailConfig(loadEmailConfig({}))).toThrow(
      'Missing required configuration: SMTP_HOST',
    );

    expect(() =>
      requireEmailConfig(
        loadEmailConfig({
          SMTP_HOST: 'smtp.example.com',
          SMTP_USERNAME: 'mailer-user',
          SMTP_PASSWORD: 'mailer-password',
        }),
      ),
    ).toThrow('Missing required configuration: SMTP_FROM_EMAIL');
  });

  it('does not expose SMTP credentials in configuration errors', () => {
    const smtpPassword = 'super-secret-smtp-password';

    try {
      requireEmailConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecure: false,
        smtpUsername: 'mailer-user',
        smtpPassword: '',
        fromEmail: 'no-reply@example.com',
      });
      expect.unreachable('expected requireEmailConfig to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(smtpPassword);
      expect(message).toBe('Missing required configuration: SMTP_PASSWORD');
    }
  });

  it('makes refresh cookies Secure in production unless overridden', () => {
    const production = loadAuthConfig({ NODE_ENV: 'production' });
    expect(production.cookie.secure).toBe(true);

    const overridden = loadAuthConfig({
      NODE_ENV: 'production',
      REFRESH_COOKIE_SECURE: 'false',
    });
    expect(overridden.cookie.secure).toBe(false);
  });

  it('requires a sufficiently long JWT secret without echoing it', () => {
    const secret = 'short-secret-should-not-leak';

    expect(() => requireAuthConfig(loadAuthConfig({}))).toThrow(
      'Missing required configuration: JWT_SECRET',
    );

    try {
      requireAuthConfig({
        jwtSecret: secret,
        jwtIssuer: 'xplooreze',
        jwtAudience: 'xplooreze-api',
        accessTokenTtl: '15m',
        refreshTokenTtl: '7d',
        passwordResetTokenTtl: '30m',
        cookie: { name: 'refresh_token', path: '/auth', sameSite: 'lax', secure: false },
      });
      expect.unreachable('expected requireAuthConfig to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).toBe('Invalid JWT_SECRET: must be at least 32 characters.');
    }
  });

  it('loads password reset auth configuration without making the reset URL mandatory at boot', () => {
    const config = loadAuthConfig({
      PASSWORD_RESET_TOKEN_TTL: '45m',
      PASSWORD_RESET_URL_BASE: 'http://localhost:5173/reset-password',
    });

    expect(config.passwordResetTokenTtl).toBe('45m');
    expect(config.passwordResetUrlBase).toBe('http://localhost:5173/reset-password');
  });

  it('requires MongoDB URI only when database integration is initialized', () => {
    const config = loadDatabaseConfig({});

    expect(() => requireDatabaseConfig(config)).toThrow(
      'Missing required configuration: MONGODB_URI',
    );
  });

  it('does not expose MongoDB URI values in configuration errors', () => {
    const secretUri = 'mongodb://user:super-secret-password@localhost:27017/app';

    try {
      requireDatabaseConfig({ uri: '' });
      expect.unreachable('expected requireDatabaseConfig to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('super-secret-password');
      expect(message).not.toContain(secretUri);
      expect(message).toBe('Missing required configuration: MONGODB_URI');
    }
  });

  it('requires Blob credentials when Blob integration is initialized', () => {
    expect(() => requireBlobConfig(loadBlobConfig({}))).toThrow(
      'Invalid Blob configuration: set BLOB_READ_WRITE_TOKEN or both BLOB_STORE_ID and VERCEL_OIDC_TOKEN',
    );
  });

  it('rejects partial Blob OIDC configuration without echoing secrets', () => {
    const token = 'vercel-oidc-token-should-not-leak';

    try {
      requireBlobConfig({
        storeId: 'store_test',
        oidcToken: '',
        cleanupEnabled: true,
        cleanupIntervalMs: 60 * 60 * 1000,
      });
      expect.unreachable('expected requireBlobConfig to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(token);
      expect(message).toContain(
        'BLOB_READ_WRITE_TOKEN or both BLOB_STORE_ID and VERCEL_OIDC_TOKEN',
      );
    }
  });

  it('loads Blob cleanup defaults and env overrides', () => {
    const defaults = loadBlobConfig({
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test',
    });
    expect(defaults.cleanupEnabled).toBe(true);
    expect(defaults.cleanupIntervalMs).toBe(60 * 60 * 1000);

    const onVercel = loadBlobConfig({
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test',
      VERCEL: '1',
    });
    expect(onVercel.cleanupEnabled).toBe(false);

    const overridden = loadBlobConfig({
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test',
      BLOB_CLEANUP_ENABLED: 'false',
      BLOB_CLEANUP_INTERVAL_MS: '120000',
    });
    expect(overridden.cleanupEnabled).toBe(false);
    expect(overridden.cleanupIntervalMs).toBe(120000);

    expect(() => loadBlobConfig({ BLOB_CLEANUP_ENABLED: 'yes' })).toThrow(
      'Invalid BLOB_CLEANUP_ENABLED. Expected true or false.',
    );
  });

  it('accepts valid Blob configuration with a read-write token', () => {
    const config = requireBlobConfig({
      readWriteToken: 'vercel_blob_rw_test',
      cleanupEnabled: true,
      cleanupIntervalMs: 60 * 60 * 1000,
    });

    expect(config).toEqual({
      readWriteToken: 'vercel_blob_rw_test',
      access: 'private',
      uploadUrlTtlSeconds: 300,
      downloadUrlTtlSeconds: 60,
    });
  });

  it('loads BLOB_ACCESS public when configured', () => {
    const config = loadBlobConfig({
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test',
      BLOB_ACCESS: 'public',
    });

    expect(requireBlobConfig(config).access).toBe('public');
  });

  it('rejects invalid BLOB_ACCESS', () => {
    expect(() => loadBlobConfig({ BLOB_ACCESS: 'internal' })).toThrow(
      'Invalid BLOB_ACCESS. Expected public or private.',
    );
  });

  it('requires Razorpay keys when Razorpay integration is initialized', () => {
    expect(() => requireRazorpayConfig(loadRazorpayConfig({}))).toThrow(
      'Missing required configuration: RAZORPAY_KEY_ID',
    );

    expect(() =>
      requireRazorpayConfig({
        keyId: 'rzp_test_key',
      }),
    ).toThrow('Missing required configuration: RAZORPAY_KEY_SECRET');
  });

  it('does not expose Razorpay secrets in configuration errors', () => {
    const secret = 'rzp_test_should_never_appear';

    try {
      requireRazorpayConfig({
        keyId: 'rzp_test_key',
        keySecret: '',
      });
      expect.unreachable('expected requireRazorpayConfig to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).toBe('Missing required configuration: RAZORPAY_KEY_SECRET');
    }
  });

  it('accepts valid Razorpay configuration', () => {
    const config = requireRazorpayConfig({
      keyId: 'rzp_test_key',
      keySecret: 'rzp_test_secret',
      webhookSecret: 'whsec_test',
    });

    expect(config.keyId).toBe('rzp_test_key');
    expect(config.keySecret).toBe('rzp_test_secret');
    expect(config.webhookSecret).toBe('whsec_test');
  });
});
