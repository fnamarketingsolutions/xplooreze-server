import { mapPersistenceError } from '../../database/errors';
import { httpIdempotencyKeyRepository } from '../../database/repositories/index';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import {
  idempotencyKeyReusedError,
  idempotencyRequestInProgressError,
  type IdempotencyErrorSnapshot,
  type IdempotencyResponseSnapshot,
} from '../../shared/http/idempotency';

const IN_PROGRESS_POLL_MS = 25;
const IN_PROGRESS_WAIT_MS = 15_000;

export type IdempotencyOperationResult<T> = {
  statusCode: number;
  data: T;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPersistableClientError(error: unknown): error is AppError {
  return error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500;
}

function asResponseSnapshot(value: unknown): IdempotencyResponseSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (record.type === 'success') {
    return { type: 'success', data: record.data };
  }

  if (
    record.type === 'error' &&
    typeof record.code === 'string' &&
    typeof record.message === 'string'
  ) {
    return {
      type: 'error',
      code: record.code,
      message: record.message,
    };
  }

  return null;
}

function replayCompleted<T>(
  record: {
    requestHash: string;
    httpStatus?: number | null;
    response?: unknown;
  },
  requestHash: string,
): IdempotencyOperationResult<T> {
  if (record.requestHash !== requestHash) {
    throw idempotencyKeyReusedError();
  }

  const snapshot = asResponseSnapshot(record.response);

  if (!snapshot || typeof record.httpStatus !== 'number') {
    throw new AppError({
      statusCode: 500,
      code: ErrorCodes.INTERNAL_SERVER_ERROR,
      message: 'Idempotent result is unavailable.',
    });
  }

  if (snapshot.type === 'error') {
    throw new AppError({
      statusCode: record.httpStatus,
      code: snapshot.code,
      message: snapshot.message,
    });
  }

  return {
    statusCode: record.httpStatus,
    data: snapshot.data as T,
  };
}

async function claimRecord(input: {
  userId: string;
  operation: string;
  key: string;
  requestHash: string;
}) {
  try {
    const created = await httpIdempotencyKeyRepository.create({
      userId: input.userId,
      operation: input.operation,
      key: input.key,
      requestHash: input.requestHash,
    });
    return { type: 'claimed' as const, record: created };
  } catch (error) {
    const mapped = mapPersistenceError(error);
    if (mapped?.code !== ErrorCodes.DUPLICATE_KEY) {
      throw error;
    }

    const existing = await httpIdempotencyKeyRepository.findByIdentity(
      input.userId,
      input.operation,
      input.key,
    );

    if (!existing) {
      return { type: 'retry' as const };
    }

    return { type: 'existing' as const, record: existing };
  }
}

async function completeSuccess<T>(
  recordId: { toString(): string },
  statusCode: number,
  data: T,
): Promise<void> {
  const snapshot: IdempotencyResponseSnapshot<T> = { type: 'success', data };
  await httpIdempotencyKeyRepository.completeIfProcessing(recordId.toString(), {
    httpStatus: statusCode,
    response: snapshot,
  });
}

async function completeClientError(
  recordId: { toString(): string },
  error: AppError,
): Promise<void> {
  const snapshot: IdempotencyErrorSnapshot = {
    type: 'error',
    code: error.code,
    message: error.message,
  };
  await httpIdempotencyKeyRepository.completeIfProcessing(recordId.toString(), {
    httpStatus: error.statusCode,
    response: snapshot,
  });
}

async function waitForCompletion<T>(input: {
  userId: string;
  operation: string;
  key: string;
  requestHash: string;
  execute: () => Promise<T>;
  successStatusCode: number;
}): Promise<IdempotencyOperationResult<T>> {
  const deadline = Date.now() + IN_PROGRESS_WAIT_MS;

  while (Date.now() < deadline) {
    await delay(IN_PROGRESS_POLL_MS);

    const current = await httpIdempotencyKeyRepository.findByIdentity(
      input.userId,
      input.operation,
      input.key,
    );

    if (!current) {
      return runIdempotentOperation(input);
    }

    if (current.requestHash !== input.requestHash) {
      throw idempotencyKeyReusedError();
    }

    if (current.status === 'COMPLETED') {
      return replayCompleted<T>(current, input.requestHash);
    }
  }

  throw idempotencyRequestInProgressError();
}

export async function runIdempotentOperation<T>(input: {
  userId: string;
  operation: string;
  key: string;
  requestHash: string;
  execute: () => Promise<T>;
  successStatusCode?: number;
}): Promise<IdempotencyOperationResult<T>> {
  const successStatusCode = input.successStatusCode ?? 200;
  const claim = await claimRecord(input);

  if (claim.type === 'retry') {
    return runIdempotentOperation(input);
  }

  if (claim.type === 'existing') {
    if (claim.record.requestHash !== input.requestHash) {
      throw idempotencyKeyReusedError();
    }

    if (claim.record.status === 'COMPLETED') {
      return replayCompleted<T>(claim.record, input.requestHash);
    }

    return waitForCompletion({ ...input, successStatusCode });
  }

  try {
    const data = await input.execute();
    await completeSuccess(claim.record._id, successStatusCode, data);
    return { statusCode: successStatusCode, data };
  } catch (error) {
    if (isPersistableClientError(error)) {
      await completeClientError(claim.record._id, error);
      throw error;
    }

    await httpIdempotencyKeyRepository.deleteIfProcessing(claim.record._id);
    throw error;
  }
}
