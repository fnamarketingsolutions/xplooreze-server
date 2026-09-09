import { AppError, ErrorCodes } from '../../shared/errors/app-error';

/** Country code then subscriber number, stored as `+` plus 8–15 digits. */
export const MOBILE_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/;

export function isValidMobileNumber(value: string): boolean {
  return MOBILE_NUMBER_PATTERN.test(value);
}

export function normalizeMobileNumber(value: string): string {
  return value.trim().replace(/[\s()-]/g, '');
}

export function mobileAlreadyRegistered(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.MOBILE_NUMBER_ALREADY_REGISTERED,
    message: 'An account with this mobile number already exists.',
  });
}

export function isMobileNumberDuplicate(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const keyPattern = 'keyPattern' in error ? error.keyPattern : undefined;
  if (keyPattern !== null && typeof keyPattern === 'object' && 'mobileNumber' in keyPattern) {
    return true;
  }

  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return message.includes('mobileNumber');
}
