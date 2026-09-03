import { optionalString, requireConfigString } from './env-helpers';

export type EmailConfig = {
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  fromEmail?: string;
  fromName?: string;
};

export type RequiredEmailConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  fromEmail: string;
  fromName?: string;
};

const DEFAULT_SMTP_PORT = 587;

function parseSmtpPort(value: string | undefined): number {
  const raw = optionalString(value);

  if (!raw) {
    return DEFAULT_SMTP_PORT;
  }

  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SMTP_PORT value: ${raw}. Expected an integer between 1 and 65535.`);
  }

  return port;
}

function parseSmtpSecure(value: string | undefined): boolean {
  const raw = optionalString(value)?.toLowerCase();

  if (!raw) {
    return false;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new Error('Invalid SMTP_SECURE value. Expected true or false.');
}

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  return {
    smtpHost: optionalString(env.SMTP_HOST),
    smtpPort: parseSmtpPort(env.SMTP_PORT),
    smtpSecure: parseSmtpSecure(env.SMTP_SECURE),
    smtpUsername: optionalString(env.SMTP_USERNAME),
    smtpPassword: optionalString(env.SMTP_PASSWORD),
    fromEmail: optionalString(env.SMTP_FROM_EMAIL),
    fromName: optionalString(env.SMTP_FROM_NAME),
  };
}

/**
 * Validates SMTP configuration when email delivery is actually used.
 * Error messages never echo credential values.
 */
export function requireEmailConfig(config: EmailConfig): RequiredEmailConfig {
  const smtpHost = requireConfigString(config.smtpHost, 'SMTP_HOST');
  const smtpUsername = requireConfigString(config.smtpUsername, 'SMTP_USERNAME');
  const smtpPassword = requireConfigString(config.smtpPassword, 'SMTP_PASSWORD');
  const fromEmail = requireConfigString(config.fromEmail, 'SMTP_FROM_EMAIL');

  return {
    smtpHost,
    smtpPort: config.smtpPort,
    smtpSecure: config.smtpSecure,
    smtpUsername,
    smtpPassword,
    fromEmail,
    ...(config.fromName ? { fromName: config.fromName } : {}),
  };
}
