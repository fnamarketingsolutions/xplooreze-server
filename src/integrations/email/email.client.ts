import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { getConfig, requireEmailConfig } from '../../config/index';
import type { EmailConfig, RequiredEmailConfig } from '../../config/email';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';

export type EmailAddress = {
  address: string;
  name?: string;
};

export type EmailSendInput = {
  from?: EmailAddress;
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

export type EmailClient = {
  sendMail(input: EmailSendInput): Promise<void>;
};

export type EmailClientHandle = {
  transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo>;
  defaultFrom: EmailAddress;
};

let cached: EmailClientHandle | null = null;

function emailConfigError(message: string, cause?: unknown): AppError {
  return new AppError({
    statusCode: 500,
    code: ErrorCodes.EMAIL_CONFIGURATION_INVALID,
    message,
    cause,
  });
}

function emailDeliveryFailed(message: string, cause?: unknown): AppError {
  return new AppError({
    statusCode: 502,
    code: ErrorCodes.EMAIL_DELIVERY_FAILED,
    message,
    cause,
  });
}

function toTransportOptions(config: RequiredEmailConfig): SMTPTransport.Options {
  return {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUsername,
      pass: config.smtpPassword,
    },
  };
}

function toDefaultFrom(config: RequiredEmailConfig): EmailAddress {
  return {
    address: config.fromEmail,
    ...(config.fromName ? { name: config.fromName } : {}),
  };
}

function createTransporter(config: RequiredEmailConfig) {
  return nodemailer.createTransport(toTransportOptions(config));
}

export function createEmailClient(config: EmailConfig = getConfig().email): EmailClientHandle {
  let required: RequiredEmailConfig;

  try {
    required = requireEmailConfig(config);
  } catch (error) {
    throw emailConfigError('Email service is not configured.', error);
  }

  return {
    transporter: createTransporter(required),
    defaultFrom: toDefaultFrom(required),
  };
}

export function getEmailClient(): EmailClientHandle {
  if (cached) {
    return cached;
  }

  const handle = createEmailClient();
  const config = requireEmailConfig(getConfig().email);
  cached = handle;

  getLogger({ module: 'email', event: 'EMAIL_TRANSPORT_INITIALIZED' }).info(
    {
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      fromEmail: handle.defaultFrom.address,
    },
    'Email transport initialized',
  );

  return handle;
}

export async function sendWithEmailClient(input: EmailSendInput): Promise<void> {
  const handle = getEmailClient();
  const logger = getLogger({ module: 'email' });

  logger.info(
    {
      event: 'EMAIL_SEND_ATTEMPTED',
      to: input.to,
      subject: input.subject,
    },
    'Attempting to send application email',
  );

  try {
    await handle.transporter.sendMail({
      from: input.from ?? handle.defaultFrom,
      to: input.to,
      subject: input.subject,
      ...(input.text ? { text: input.text } : {}),
      ...(input.html ? { html: input.html } : {}),
    });
  } catch (error) {
    logger.error(
      {
        event: 'EMAIL_SEND_FAILED',
        to: input.to,
        subject: input.subject,
      },
      'Application email delivery failed',
    );

    throw emailDeliveryFailed('Unable to send email at this time.', error);
  }

  logger.info(
    {
      event: 'EMAIL_SEND_SUCCEEDED',
      to: input.to,
      subject: input.subject,
    },
    'Application email sent',
  );
}

export function resetEmailClientForTests(): void {
  cached = null;
}
