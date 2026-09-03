import { EXAM_SESSION_LOCK_TTL_MS } from '../../database/models/conventions';
import type { AttemptStatus } from '../../database/models/enums';
import { attemptRepository } from '../../database/repositories/index';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { validationError } from '../../shared/validation/http';

export const EXAM_SESSION_HEADER = 'x-exam-session-id';

/** UUID (any version) — client generates per exam overlay. */
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPEN_ATTEMPT_STATUSES: AttemptStatus[] = ['IN_PROGRESS', 'UPLOAD_PENDING'];
const TERMINAL_ATTEMPT_STATUSES: AttemptStatus[] = ['SUBMITTED', 'EXPIRED', 'CANCELLED'];

export type ExamSessionClaimDto = {
  attemptId: string;
  sessionId: string;
  expiresAt: string | null;
  locked: boolean;
};

export function examSessionConflict(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.EXAM_SESSION_CONFLICT,
    message: 'This exam is open in another tab or device.',
  });
}

export function examSessionClearFields(): {
  activeSessionId: null;
  activeSessionExpiresAt: null;
} {
  return {
    activeSessionId: null,
    activeSessionExpiresAt: null,
  };
}

export function parseExamSessionIdValue(value: unknown, field = 'sessionId'): string {
  if (typeof value !== 'string') {
    throw validationError({ [field]: 'Must be a string.' });
  }

  const trimmed = value.trim();

  if (!SESSION_ID_PATTERN.test(trimmed)) {
    throw validationError({ [field]: 'Must be a UUID.' });
  }

  return trimmed;
}

export function parseExamSessionIdHeader(
  header: string | string[] | undefined,
): string {
  if (header === undefined) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Request validation failed.',
      details: { fields: { [EXAM_SESSION_HEADER]: 'Required.' } },
    });
  }

  const raw = Array.isArray(header) ? header[0] : header;
  return parseExamSessionIdValue(raw, EXAM_SESSION_HEADER);
}

function isSessionLockActive(
  attempt: {
    activeSessionId?: string | null;
    activeSessionExpiresAt?: Date | null;
  },
  now: Date,
): boolean {
  const sessionId = attempt.activeSessionId;
  const expiresAt = attempt.activeSessionExpiresAt;

  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    expiresAt instanceof Date &&
    expiresAt.getTime() > now.getTime()
  );
}

function expiresAtFrom(now: Date): Date {
  return new Date(now.getTime() + EXAM_SESSION_LOCK_TTL_MS);
}

/**
 * Claim or refresh the exclusive exam session lock.
 * Idempotent for the same sessionId. 409 if another unexpired session holds it.
 * Terminal attempts clear any lock and return unlocked.
 */
export async function claimExamSession(
  studentId: string,
  attemptId: string,
  sessionId: string,
  now = new Date(),
): Promise<ExamSessionClaimDto> {
  const attempt = await attemptRepository.findById(attemptId);

  if (!attempt || attempt.studentId.toString() !== studentId) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCodes.ATTEMPT_NOT_FOUND,
      message: 'Attempt not found.',
    });
  }

  if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) {
    if (attempt.activeSessionId != null || attempt.activeSessionExpiresAt != null) {
      await attemptRepository.updateById(attemptId, {
        $set: examSessionClearFields(),
      });
    }

    return {
      attemptId,
      sessionId,
      expiresAt: null,
      locked: false,
    };
  }

  if (!OPEN_ATTEMPT_STATUSES.includes(attempt.status)) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.ATTEMPT_NOT_WRITABLE,
      message: 'Attempt is not writable.',
    });
  }

  const expiresAt = expiresAtFrom(now);
  const claimed = await attemptRepository.claimExamSession(
    attemptId,
    studentId,
    sessionId,
    expiresAt,
    now,
  );

  if (!claimed) {
    throw examSessionConflict();
  }

  return {
    attemptId,
    sessionId,
    expiresAt: expiresAt.toISOString(),
    locked: true,
  };
}

/**
 * Release the lock if this session owns it. Idempotent otherwise.
 */
export async function releaseExamSession(
  studentId: string,
  attemptId: string,
  sessionId: string,
): Promise<void> {
  const attempt = await attemptRepository.findById(attemptId);

  if (!attempt || attempt.studentId.toString() !== studentId) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCodes.ATTEMPT_NOT_FOUND,
      message: 'Attempt not found.',
    });
  }

  await attemptRepository.releaseExamSession(attemptId, studentId, sessionId);
}

/**
 * Ensure the caller holds the active exam session. If unlocked/expired, claim
 * for this sessionId (mutation path). Throws EXAM_SESSION_CONFLICT when another
 * session holds an unexpired lock.
 */
export async function assertOrClaimExamSession(
  studentId: string,
  attemptId: string,
  sessionId: string,
  now = new Date(),
): Promise<void> {
  const attempt = await attemptRepository.findById(attemptId);

  if (!attempt || attempt.studentId.toString() !== studentId) {
    throw new AppError({
      statusCode: 404,
      code: ErrorCodes.ATTEMPT_NOT_FOUND,
      message: 'Attempt not found.',
    });
  }

  if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) {
    return;
  }

  if (!OPEN_ATTEMPT_STATUSES.includes(attempt.status)) {
    return;
  }

  if (
    isSessionLockActive(attempt, now) &&
    attempt.activeSessionId === sessionId
  ) {
    return;
  }

  const expiresAt = expiresAtFrom(now);
  const claimed = await attemptRepository.claimExamSession(
    attemptId,
    studentId,
    sessionId,
    expiresAt,
    now,
  );

  if (!claimed) {
    throw examSessionConflict();
  }
}
