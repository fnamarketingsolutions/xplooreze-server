import type { UserStatus } from '../../database/models/enums';
import { accountDisabledError } from '../../shared/errors/app-error';

export function isContinuableAttemptStatus(status: string): boolean {
  return status === 'IN_PROGRESS' || status === 'UPLOAD_PENDING';
}

/**
 * Disabled students may continue an already-running Attempt only.
 * New starts and unrelated protected workflows still require ACTIVE.
 */
export function assertActiveOrContinuableAttempt(
  accountStatus: UserStatus,
  attemptStatus: string,
): void {
  if (accountStatus === 'ACTIVE') {
    return;
  }

  if (isContinuableAttemptStatus(attemptStatus)) {
    return;
  }

  throw accountDisabledError();
}
