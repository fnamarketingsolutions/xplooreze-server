import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { isValidEmail, normalizeEmail } from './email';
import { isValidMobileNumber, normalizeMobileNumber } from './mobile-number';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 100;

export type RegisterInput = {
  email: string;
  password: string;
  mobileNumber: string;
  name: {
    first: string;
    last: string;
  };
};

export type UpdateOwnMobileNumberInput = {
  mobileNumber: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type ForgotPasswordInput = {
  email: string;
};

export type ResetPasswordInput = {
  token: string;
  password: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ body: 'Request body must be a JSON object.' });
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw validationError({ [field]: 'Must be a string.' });
  }

  return value;
}

function validationError(fields: Record<string, string>): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.VALIDATION_ERROR,
    message: 'Request validation failed.',
    details: { fields },
  });
}

function rejectUnknownFields(record: Record<string, unknown>, allowedFields: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowedFields.includes(key)) {
      throw validationError({ [key]: 'Unknown field.' });
    }
  }
}

function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw validationError({
      password: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    });
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    throw validationError({
      password: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    });
  }
}

export function validateMobileNumber(value: unknown, field = 'mobileNumber'): string {
  const normalized = normalizeMobileNumber(readString(value, field));

  if (!isValidMobileNumber(normalized)) {
    throw validationError({
      [field]: 'Must be a country code followed by the number, for example +919876543210.',
    });
  }

  return normalized;
}

function validateNamePart(value: unknown, field: string): string {
  const trimmed = readString(value, field).trim();

  if (trimmed.length === 0) {
    throw validationError({ [field]: 'Must not be empty.' });
  }

  if (trimmed.length > NAME_MAX_LENGTH) {
    throw validationError({ [field]: `Must be at most ${NAME_MAX_LENGTH} characters.` });
  }

  return trimmed;
}

export function parseRegisterInput(body: unknown): RegisterInput {
  const record = asRecord(body);
  const emailRaw = readString(record.email, 'email');
  const email = normalizeEmail(emailRaw);

  if (!isValidEmail(email)) {
    throw validationError({ email: 'Invalid email.' });
  }

  const password = readString(record.password, 'password');
  validatePassword(password);

  const nameValue = record.name;
  if (nameValue === null || typeof nameValue !== 'object' || Array.isArray(nameValue)) {
    throw validationError({ name: 'Name must include first and last.' });
  }

  const name = nameValue as Record<string, unknown>;

  return {
    email,
    password,
    mobileNumber: validateMobileNumber(record.mobileNumber),
    name: {
      first: validateNamePart(name.first, 'name.first'),
      last: validateNamePart(name.last, 'name.last'),
    },
  };
}

export function parseUpdateOwnMobileNumberInput(body: unknown): UpdateOwnMobileNumberInput {
  const record = asRecord(body);
  rejectUnknownFields(record, ['mobileNumber']);

  return {
    mobileNumber: validateMobileNumber(record.mobileNumber),
  };
}

export function parseLoginInput(body: unknown): LoginInput {
  const record = asRecord(body);
  const emailRaw = readString(record.email, 'email');
  const email = normalizeEmail(emailRaw);

  if (!isValidEmail(email)) {
    throw validationError({ email: 'Invalid email.' });
  }

  const password = readString(record.password, 'password');

  if (password.length === 0) {
    throw validationError({ password: 'Password is required.' });
  }

  return { email, password };
}

export function parseForgotPasswordInput(body: unknown): ForgotPasswordInput {
  const record = asRecord(body);
  rejectUnknownFields(record, ['email']);

  const emailRaw = readString(record.email, 'email');
  const email = normalizeEmail(emailRaw);

  if (!isValidEmail(email)) {
    throw validationError({ email: 'Invalid email.' });
  }

  return { email };
}

export function parseResetPasswordInput(body: unknown): ResetPasswordInput {
  const record = asRecord(body);
  rejectUnknownFields(record, ['token', 'password']);

  const token = readString(record.token, 'token').trim();
  if (token.length === 0) {
    throw validationError({ token: 'Token is required.' });
  }

  const password = readString(record.password, 'password');
  validatePassword(password);

  return { token, password };
}
