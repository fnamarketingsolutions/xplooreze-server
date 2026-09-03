import mongoose from 'mongoose';

import { AppError, ErrorCodes } from '../shared/errors/app-error';

const CONNECTION_ERROR_NAMES = new Set([
  'MongoNetworkError',
  'MongoServerSelectionError',
  'MongooseServerSelectionError',
  'MongoTimeoutError',
  'MongoNetworkTimeoutError',
]);

function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  if ('code' in error && error.code === 11000) {
    return true;
  }

  return error instanceof mongoose.mongo.MongoServerError && error.code === 11000;
}

function isValidationError(error: unknown): boolean {
  return (
    error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError
  );
}

function isConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }

  return typeof error.name === 'string' && CONNECTION_ERROR_NAMES.has(error.name);
}

/**
 * Maps common MongoDB/Mongoose failures to safe AppErrors.
 * Does not include driver messages, URIs, or stack traces.
 */
export function mapPersistenceError(error: unknown): AppError | null {
  if (error instanceof AppError) {
    return error;
  }

  if (isDuplicateKeyError(error)) {
    return new AppError({
      statusCode: 409,
      code: ErrorCodes.DUPLICATE_KEY,
      message: 'A conflicting record already exists.',
    });
  }

  if (isValidationError(error)) {
    return new AppError({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Invalid data.',
    });
  }

  if (isConnectionError(error)) {
    return new AppError({
      statusCode: 503,
      code: ErrorCodes.DATABASE_UNAVAILABLE,
      message: 'Database is temporarily unavailable.',
    });
  }

  return null;
}

export function remapDuplicateKey(error: unknown, conflict: AppError): never {
  const mapped = mapPersistenceError(error);

  if (mapped?.code === ErrorCodes.DUPLICATE_KEY) {
    throw conflict;
  }

  throw error;
}
