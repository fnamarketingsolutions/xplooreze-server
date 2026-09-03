import { createHash } from 'node:crypto';

import type { Request } from 'express';

import { AppError, ErrorCodes } from '../errors/app-error';
import { validationError } from '../validation/http';

export const IDEMPOTENCY_OPERATIONS = {
  PURCHASES_CREATE: 'POST /purchases',
} as const;

export type IdempotencyOperation =
  (typeof IDEMPOTENCY_OPERATIONS)[keyof typeof IDEMPOTENCY_OPERATIONS];

/** Implementation limit. Architecture does not lock Idempotency-Key length/format. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

function hasDisallowedIdempotencyKeyCharacters(key: string): boolean {
  for (const char of key) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127 || /\s/.test(char)) {
      return true;
    }
  }

  return false;
}

export type IdempotencySuccessSnapshot<T> = {
  type: 'success';
  data: T;
};

export type IdempotencyErrorSnapshot = {
  type: 'error';
  code: string;
  message: string;
};

export type IdempotencyResponseSnapshot<T = unknown> =
  IdempotencySuccessSnapshot<T> | IdempotencyErrorSnapshot;

export function readRequiredIdempotencyKey(req: Request): string {
  const header = req.headers['idempotency-key'];

  if (header === undefined) {
    throw validationError({ 'Idempotency-Key': 'Header is required.' });
  }

  if (Array.isArray(header)) {
    throw validationError({ 'Idempotency-Key': 'Must be a single value.' });
  }

  if (typeof header !== 'string') {
    throw validationError({ 'Idempotency-Key': 'Must be a single opaque token.' });
  }

  const key = header.trim();

  if (key.length === 0) {
    throw validationError({ 'Idempotency-Key': 'Must not be empty.' });
  }

  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw validationError({
      'Idempotency-Key': `Must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
    });
  }

  if (hasDisallowedIdempotencyKeyCharacters(key)) {
    throw validationError({ 'Idempotency-Key': 'Must be a single opaque token.' });
  }

  return key;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function hashIdempotencyRequest(canonicalInput: unknown): string {
  return createHash('sha256').update(stableStringify(canonicalInput)).digest('hex');
}

export function idempotencyKeyReusedError(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.IDEMPOTENCY_KEY_REUSED,
    message: 'Idempotency-Key was already used for a different request.',
  });
}

export function idempotencyRequestInProgressError(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.IDEMPOTENCY_REQUEST_IN_PROGRESS,
    message: 'A request with this Idempotency-Key is already in progress.',
  });
}
