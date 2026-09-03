import { sendWithEmailClient } from '../../integrations/email/index';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { isValidEmail, normalizeEmail } from '../auth/email';

export type SendEmailInput = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

function invalidEmailRequest(message: string): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.VALIDATION_ERROR,
    message,
  });
}

export function validateSendEmailInput(input: SendEmailInput): SendEmailInput {
  const to = normalizeEmail(input.to);
  const subject = input.subject.trim();
  const text = input.text?.trim();
  const html = input.html?.trim();

  if (!isValidEmail(to)) {
    throw invalidEmailRequest('A valid recipient email address is required.');
  }

  if (subject.length === 0) {
    throw invalidEmailRequest('Email subject is required.');
  }

  if (!text && !html) {
    throw invalidEmailRequest('Email content requires text or html.');
  }

  return {
    to,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
  };
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const valid = validateSendEmailInput(input);
  await sendWithEmailClient(valid);
}
