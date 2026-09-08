import { describe, expect, it } from 'vitest';

import { PENDING_PURCHASE_REUSE_WINDOW_MS } from '../src/database/models/conventions';
import { AppError, ErrorCodes } from '../src/shared/errors/app-error';
import {
  hashIdempotencyRequest,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_OPERATIONS,
  readRequiredIdempotencyKey,
  stableStringify,
} from '../src/shared/http/idempotency';
import { isPendingPurchaseReusable } from '../src/modules/purchases/purchase.service';
import { PURCHASE_STATUSES } from '../src/database/models/enums';

function requestWithIdempotencyHeader(value: unknown) {
  return {
    headers: {
      'idempotency-key': value,
    },
  } as unknown as Parameters<typeof readRequiredIdempotencyKey>[0];
}

function expectValidationError(run: () => void) {
  try {
    run();
    expect.unreachable('expected validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
    });
  }
}

describe('HTTP idempotency key validation', () => {
  it('requires a single non-empty opaque header value', () => {
    expectValidationError(() =>
      readRequiredIdempotencyKey(requestWithIdempotencyHeader(undefined)),
    );
    expectValidationError(() => readRequiredIdempotencyKey(requestWithIdempotencyHeader('')));
    expectValidationError(() => readRequiredIdempotencyKey(requestWithIdempotencyHeader('   ')));
    expectValidationError(() =>
      readRequiredIdempotencyKey(requestWithIdempotencyHeader(['a', 'b'])),
    );
    expectValidationError(() =>
      readRequiredIdempotencyKey(
        requestWithIdempotencyHeader('a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)),
      ),
    );
    expectValidationError(() =>
      readRequiredIdempotencyKey(requestWithIdempotencyHeader('abc def')),
    );

    expect(readRequiredIdempotencyKey(requestWithIdempotencyHeader('abc-123'))).toBe('abc-123');
    expect(readRequiredIdempotencyKey(requestWithIdempotencyHeader('  uuid-key  '))).toBe(
      'uuid-key',
    );
  });
});

describe('HTTP idempotency request fingerprints', () => {
  it('hashes only canonical operation input with deterministic serialization', () => {
    expect(stableStringify({ testSeriesId: 'b', extra: undefined })).toBe(
      stableStringify({ extra: undefined, testSeriesId: 'b' }),
    );
    expect(hashIdempotencyRequest({ testSeriesId: 'ts_1' })).toBe(
      hashIdempotencyRequest({ testSeriesId: 'ts_1' }),
    );
    expect(hashIdempotencyRequest({ b: 1, a: 2 })).toBe(hashIdempotencyRequest({ a: 2, b: 1 }));
    expect(hashIdempotencyRequest({ testSeriesId: 'ts_1' })).not.toBe(
      hashIdempotencyRequest({ testSeriesId: 'ts_2' }),
    );
    expect(hashIdempotencyRequest({ testSeriesId: 'ts_1' })).not.toContain('Bearer');
    expect(IDEMPOTENCY_OPERATIONS.PURCHASES_CREATE).toBe('POST /purchases');
  });
});

describe('PENDING purchase reuse window', () => {
  it('reuses before 30 minutes and rejects reuse at or after 30 minutes', () => {
    const createdAt = new Date('2026-08-18T10:00:00.000Z');

    expect(
      isPendingPurchaseReusable(
        createdAt,
        new Date(createdAt.getTime() + PENDING_PURCHASE_REUSE_WINDOW_MS - 1),
      ),
    ).toBe(true);
    expect(
      isPendingPurchaseReusable(
        createdAt,
        new Date(createdAt.getTime() + PENDING_PURCHASE_REUSE_WINDOW_MS),
      ),
    ).toBe(false);
    expect(
      isPendingPurchaseReusable(
        createdAt,
        new Date(createdAt.getTime() + PENDING_PURCHASE_REUSE_WINDOW_MS + 1),
      ),
    ).toBe(false);
    expect(PURCHASE_STATUSES).toEqual(['PENDING', 'PAID', 'FAILED']);
    expect(PURCHASE_STATUSES).not.toContain('EXPIRED');
  });
});
