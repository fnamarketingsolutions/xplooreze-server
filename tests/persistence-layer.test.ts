import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { mapPersistenceError } from '../src/database/errors';
import {
  attemptRepository,
  authSessionRepository,
  categoryRepository,
  entitlementRepository,
  evaluationRepository,
  evaluationRevisionRepository,
  httpIdempotencyKeyRepository,
  moduleRepository,
  testSeriesRepository,
  userRepository,
} from '../src/database/repositories/index';
import { startSession, withTransaction } from '../src/database/transactions';
import { ErrorCodes } from '../src/shared/errors/app-error';

describe('repository foundation', () => {
  it('exposes persistence operations without domain workflow methods', () => {
    expect(userRepository).toHaveProperty('findById');
    expect(userRepository).toHaveProperty('findByEmail');
    expect(userRepository).toHaveProperty('create');

    expect(authSessionRepository).toHaveProperty('findByRefreshTokenHash');
    expect(authSessionRepository).toHaveProperty('create');
    expect(authSessionRepository).toHaveProperty('markReplaced');
    expect(authSessionRepository).toHaveProperty('revokeFamily');
    expect(authSessionRepository).not.toHaveProperty('login');
    expect(authSessionRepository).not.toHaveProperty('refresh');

    expect(entitlementRepository).toHaveProperty('findActiveByStudentAndTestSeries');
    expect(entitlementRepository).not.toHaveProperty('assertAccess');
    expect(entitlementRepository).not.toHaveProperty('grant');

    expect(attemptRepository).toHaveProperty('findInProgressByStudentAndTestSeries');
    expect(attemptRepository).toHaveProperty('countByEntitlementId');
    expect(attemptRepository).toHaveProperty('updateById');
    expect(attemptRepository).not.toHaveProperty('startAttempt');
    expect(attemptRepository).not.toHaveProperty('resumeAttempt');
    expect(attemptRepository).not.toHaveProperty('submit');

    expect(categoryRepository).toHaveProperty('list');
    expect(categoryRepository).toHaveProperty('updateById');
    expect(categoryRepository).toHaveProperty('softDeleteById');
    expect(categoryRepository).not.toHaveProperty('archive');
    expect(moduleRepository).toHaveProperty('list');
    expect(moduleRepository).not.toHaveProperty('moveToCategory');
    expect(testSeriesRepository).toHaveProperty('list');
    expect(testSeriesRepository).not.toHaveProperty('publish');
    expect(testSeriesRepository).not.toHaveProperty('startAttempt');

    expect(evaluationRepository).toHaveProperty('findBySubmissionId');
    expect(evaluationRepository).toHaveProperty('findOneAndUpdate');
    expect(evaluationRepository).not.toHaveProperty('finalizeEvaluation');
    expect(evaluationRepository).not.toHaveProperty('assignEvaluator');
    expect(evaluationRevisionRepository).toHaveProperty('create');
    expect(evaluationRevisionRepository).toHaveProperty('findLatestByEvaluationId');
    expect(evaluationRevisionRepository).not.toHaveProperty('reopen');
    expect(evaluationRevisionRepository).not.toHaveProperty('completeEvaluation');

    expect(httpIdempotencyKeyRepository).toHaveProperty('create');
    expect(httpIdempotencyKeyRepository).toHaveProperty('findByIdentity');
    expect(httpIdempotencyKeyRepository).toHaveProperty('completeIfProcessing');
    expect(httpIdempotencyKeyRepository).toHaveProperty('deleteIfProcessing');
    expect(httpIdempotencyKeyRepository).not.toHaveProperty('createPurchase');
    expect(httpIdempotencyKeyRepository).not.toHaveProperty('createOrder');
  });
});

describe('transaction foundation', () => {
  it('executes work with a session through the mongoose transaction helper', async () => {
    const session = { id: 'session' };
    const transaction = vi
      .spyOn(mongoose.connection, 'transaction')
      .mockImplementation(async (work) => work(session as never));

    const result = await withTransaction(async (received) => {
      expect(received).toBe(session);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockRestore();
  });

  it('can start a session', async () => {
    const fakeSession = { id: 'started' };
    const start = vi.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession as never);

    await expect(startSession()).resolves.toBe(fakeSession);
    start.mockRestore();
  });
});

describe('persistence error mapping', () => {
  it('maps duplicate keys without leaking MongoDB details', () => {
    const mapped = mapPersistenceError({
      code: 11000,
      message: 'E11000 duplicate key error collection: app.entitlements mongodb://user:secret@db',
      errmsg: 'mongodb://user:secret@localhost:27017',
    });

    expect(mapped?.statusCode).toBe(409);
    expect(mapped?.code).toBe(ErrorCodes.DUPLICATE_KEY);
    expect(mapped?.message).toBe('A conflicting record already exists.');
    expect(mapped?.message).not.toContain('secret');
    expect(JSON.stringify(mapped)).not.toContain('secret');
    expect(JSON.stringify(mapped)).not.toContain('mongodb://');
  });

  it('maps validation failures to a generic invalid-data error', () => {
    const mapped = mapPersistenceError(new mongoose.Error.ValidationError(undefined as never));

    expect(mapped?.statusCode).toBe(400);
    expect(mapped?.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(mapped?.message).toBe('Invalid data.');
  });

  it('maps connection failures without leaking driver messages', () => {
    const mapped = mapPersistenceError({
      name: 'MongoServerSelectionError',
      message: 'connect ECONNREFUSED mongodb://user:secret@localhost:27017',
    });

    expect(mapped?.statusCode).toBe(503);
    expect(mapped?.code).toBe(ErrorCodes.DATABASE_UNAVAILABLE);
    expect(mapped?.message).toBe('Database is temporarily unavailable.');
    expect(mapped?.message).not.toContain('secret');
  });

  it('returns null for unrecognized errors', () => {
    expect(mapPersistenceError(new Error('something else'))).toBeNull();
  });
});
