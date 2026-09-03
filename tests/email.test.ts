import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import {
  createEmailClient,
  getEmailClient,
  resetEmailClientForTests,
} from '../src/integrations/email';
import { sendEmail, validateSendEmailInput } from '../src/modules/notifications/email.service';
import { AppError, ErrorCodes } from '../src/shared/errors/app-error';
import { getLogger, resetLoggerForTests } from '../src/shared/logger/logger';

const createTransportSpy = vi.fn();
const sendMailSpy = vi.fn();

vi.mock('nodemailer', () => {
  return {
    default: {
      createTransport: (options: unknown) => {
        createTransportSpy(options);
        return {
          sendMail: sendMailSpy,
        };
      },
    },
  };
});

function loadEmailTestConfig(overrides: Record<string, string> = {}) {
  resetConfigForTests();
  resetEmailClientForTests();
  resetLoggerForTests();
  createTransportSpy.mockClear();
  sendMailSpy.mockReset();

  loadConfig({
    NODE_ENV: 'test',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    CORS_ORIGIN: 'http://localhost:5173',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USERNAME: 'smtp-user',
    SMTP_PASSWORD: 'smtp-secret-password',
    SMTP_FROM_EMAIL: 'no-reply@example.com',
    SMTP_FROM_NAME: 'Xplooreze',
    ...overrides,
  });
}

describe('email transport infrastructure', () => {
  beforeEach(() => {
    loadEmailTestConfig();
  });

  it('creates a Nodemailer transport from configured SMTP values', () => {
    const handle = createEmailClient();

    expect(handle.defaultFrom).toEqual({
      address: 'no-reply@example.com',
      name: 'Xplooreze',
    });
    expect(createTransportSpy).toHaveBeenCalledTimes(1);
    expect(createTransportSpy).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: {
        user: 'smtp-user',
        pass: 'smtp-secret-password',
      },
    });
    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it('reuses a singleton Nodemailer transport', () => {
    const first = getEmailClient();
    const second = getEmailClient();

    expect(first).toBe(second);
    expect(createTransportSpy).toHaveBeenCalledTimes(1);
  });

  it('does not initialize the email transport during application startup', () => {
    createApp();

    expect(createTransportSpy).not.toHaveBeenCalled();
    expect(sendMailSpy).not.toHaveBeenCalled();
  });
});

describe('email service', () => {
  beforeEach(() => {
    loadEmailTestConfig();
  });

  it('validates recipient, subject, and content before sending', () => {
    expect(() =>
      validateSendEmailInput({
        to: 'invalid-email',
        subject: 'Subject',
        text: 'Body',
      }),
    ).toThrowError(AppError);

    try {
      validateSendEmailInput({
        to: 'invalid-email',
        subject: 'Subject',
        text: 'Body',
      });
      expect.unreachable('expected invalid email to throw');
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    }
  });

  it('passes normalized fields to transporter sendMail()', async () => {
    sendMailSpy.mockResolvedValue(undefined);

    await sendEmail({
      to: ' Student@Example.com ',
      subject: ' Password Reset Ready ',
      text: ' Plain text body ',
      html: ' <p>Hello</p> ',
    });

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    expect(sendMailSpy).toHaveBeenCalledWith({
      from: {
        address: 'no-reply@example.com',
        name: 'Xplooreze',
      },
      to: 'student@example.com',
      subject: 'Password Reset Ready',
      text: 'Plain text body',
      html: '<p>Hello</p>',
    });
  });

  it('maps SMTP failures to safe application errors without exposing Nodemailer internals', async () => {
    sendMailSpy.mockRejectedValue(new Error('535 Authentication failed for smtp-user:smtp-secret'));

    await expect(
      sendEmail({
        to: 'student@example.com',
        subject: 'Reset',
        text: 'Body',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: ErrorCodes.EMAIL_DELIVERY_FAILED,
      message: 'Unable to send email at this time.',
    });
  });

  it('does not let callers override SMTP configuration', async () => {
    sendMailSpy.mockResolvedValue(undefined);

    await sendEmail({
      to: 'student@example.com',
      subject: 'Subject',
      text: 'Body',
      smtpHost: 'attacker.example.com',
      smtpUsername: 'attacker',
    } as unknown as Parameters<typeof sendEmail>[0]);

    expect(createTransportSpy).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: {
        user: 'smtp-user',
        pass: 'smtp-secret-password',
      },
    });
  });
});

describe('email logging redaction', () => {
  beforeEach(() => {
    loadEmailTestConfig();
  });

  it('redacts SMTP credentials from logger bindings', () => {
    const logger = getLogger({
      smtpPassword: 'smtp-secret-password',
      credentials: {
        user: 'smtp-user',
        pass: 'smtp-secret-password',
      },
    });

    const bindings = JSON.stringify(logger.bindings());
    expect(bindings).not.toContain('smtp-secret-password');
    expect(bindings).not.toContain('smtp-user');
  });
});
