import { Types } from 'mongoose';

import { AppError, ErrorCodes } from '../errors/app-error';

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;

export function validationError(fields: Record<string, string>): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.VALIDATION_ERROR,
    message: 'Request validation failed.',
    details: { fields },
  });
}

export function asRecord(value: unknown, field = 'body'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ [field]: 'Request body must be a JSON object.' });
  }

  return value as Record<string, unknown>;
}

export function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw validationError({ [field]: 'Must be a string.' });
  }

  return value;
}

export function readOptionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  if (record[field] === undefined) {
    return undefined;
  }

  return readString(record[field], field);
}

export function readTrimmedString(value: unknown, field: string, maxLength: number): string {
  const trimmed = readString(value, field).trim();

  if (trimmed.length === 0) {
    throw validationError({ [field]: 'Must not be empty.' });
  }

  if (trimmed.length > maxLength) {
    throw validationError({ [field]: `Must be at most ${maxLength} characters.` });
  }

  return trimmed;
}

export function readOptionalTrimmedString(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  if (record[field] === undefined) {
    return undefined;
  }

  if (typeof record[field] !== 'string') {
    throw validationError({ [field]: 'Must be a string.' });
  }

  const trimmed = record[field].trim();

  if (trimmed.length > maxLength) {
    throw validationError({ [field]: `Must be at most ${maxLength} characters.` });
  }

  return trimmed;
}

export function readNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError({ [field]: 'Must be a finite number.' });
  }

  return value;
}

export function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw validationError({ [field]: 'Must be a boolean.' });
  }

  return value;
}

export function isObjectIdString(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value) && Types.ObjectId.isValid(value);
}

export function readObjectId(value: unknown, field: string): string {
  const raw = readString(value, field).trim();

  if (!isObjectIdString(raw)) {
    throw validationError({ [field]: 'Must be a valid id.' });
  }

  return raw;
}

export function readRouteParam(value: string | string[] | undefined, field: string): string {
  if (Array.isArray(value)) {
    throw validationError({ [field]: 'Must be a single value.' });
  }

  return readObjectId(value ?? '', field);
}

export function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));

  if (unexpected.length > 0) {
    throw validationError({ [unexpected[0]!]: 'Field is not allowed.' });
  }
}

export function requireAtLeastOneField(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const present = allowed.some((field) => record[field] !== undefined);

  if (!present) {
    throw validationError({ body: 'At least one updatable field is required.' });
  }
}

export function readQueryValue(query: Record<string, unknown>, field: string): string | undefined {
  const value = query[field];

  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    throw validationError({ [field]: 'Must be a single value.' });
  }

  if (typeof value !== 'string') {
    throw validationError({ [field]: 'Must be a string.' });
  }

  return value;
}

export function readOptionalObjectIdQuery(
  query: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = readQueryValue(query, field);

  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return readObjectId(value, field);
}

/** Parses an ISO-8601 date query filter. */
export function readOptionalDateQuery(
  query: Record<string, unknown>,
  field: string,
): Date | undefined {
  const value = readQueryValue(query, field);

  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const parsed = new Date(value.trim());

  if (Number.isNaN(parsed.getTime())) {
    throw validationError({ [field]: 'Must be a valid ISO-8601 date.' });
  }

  return parsed;
}

/** Matches PAGINATION_MAX_LIMIT; a batch lookup never needs more than one page of ids. */
export const ID_LIST_MAX_ITEMS = 100;

/** Parses a comma-separated `?ids=` batch lookup filter. */
export function readObjectIdListQuery(
  query: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = readQueryValue(query, field);

  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (ids.length === 0) {
    throw validationError({ [field]: 'Must contain at least one id.' });
  }

  if (ids.length > ID_LIST_MAX_ITEMS) {
    throw validationError({ [field]: `Must contain at most ${ID_LIST_MAX_ITEMS} ids.` });
  }

  for (const id of ids) {
    if (!isObjectIdString(id)) {
      throw validationError({ [field]: 'Must be a comma-separated list of valid ids.' });
    }
  }

  return [...new Set(ids)];
}
