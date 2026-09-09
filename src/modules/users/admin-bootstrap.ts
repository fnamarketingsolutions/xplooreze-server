import { remapDuplicateKey } from '../../database/errors';
import { userRepository } from '../../database/repositories/index';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { isMobileNumberDuplicate, mobileAlreadyRegistered } from '../auth/mobile-number';
import { getLogger } from '../../shared/logger/logger';
import { NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/auth.validation';
import { isValidEmail, normalizeEmail } from '../auth/email';
import { isValidMobileNumber, normalizeMobileNumber } from '../auth/mobile-number';
import { hashPassword } from '../auth/password';

export const ADMIN_BOOTSTRAP_EMAIL = 'ADMIN_BOOTSTRAP_EMAIL';
export const ADMIN_BOOTSTRAP_PASSWORD = 'ADMIN_BOOTSTRAP_PASSWORD';
export const ADMIN_BOOTSTRAP_FIRST_NAME = 'ADMIN_BOOTSTRAP_FIRST_NAME';
export const ADMIN_BOOTSTRAP_LAST_NAME = 'ADMIN_BOOTSTRAP_LAST_NAME';
export const ADMIN_BOOTSTRAP_MOBILE_NUMBER = 'ADMIN_BOOTSTRAP_MOBILE_NUMBER';

export type AdminBootstrapCredentials = {
  email: string;
  password: string;
  mobileNumber?: string;
  name: {
    first: string;
    last: string;
  };
};

export type AdminBootstrapResult = {
  created: boolean;
  userId: string;
};

function missingEnv(name: string): Error {
  return new Error(`Missing required environment variable: ${name}`);
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (value === undefined || value.trim() === '') {
    throw missingEnv(name);
  }

  return value.trim();
}

function readNamePart(env: NodeJS.ProcessEnv, name: string): string {
  const value = readRequired(env, name);

  if (value.length > NAME_MAX_LENGTH) {
    throw new Error(`${name} must be at most ${NAME_MAX_LENGTH} characters.`);
  }

  return value;
}

function alreadyExistsResult(userId: string): AdminBootstrapResult {
  getLogger({ module: 'seed-admin' }).info(
    { created: false, userId },
    'First admin already exists',
  );
  return { created: false, userId };
}

export function readAdminBootstrapCredentials(env: NodeJS.ProcessEnv): AdminBootstrapCredentials {
  const email = normalizeEmail(readRequired(env, ADMIN_BOOTSTRAP_EMAIL));

  if (!isValidEmail(email)) {
    throw new Error('Invalid ADMIN_BOOTSTRAP_EMAIL.');
  }

  const password = readRequired(env, ADMIN_BOOTSTRAP_PASSWORD);

  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`ADMIN_BOOTSTRAP_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`ADMIN_BOOTSTRAP_PASSWORD must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }

  const mobileRaw = env[ADMIN_BOOTSTRAP_MOBILE_NUMBER];
  const mobileNumber =
    mobileRaw === undefined || mobileRaw.trim() === ''
      ? undefined
      : normalizeMobileNumber(mobileRaw);

  if (mobileNumber !== undefined && !isValidMobileNumber(mobileNumber)) {
    throw new Error('Invalid ADMIN_BOOTSTRAP_MOBILE_NUMBER.');
  }

  return {
    email,
    password,
    ...(mobileNumber ? { mobileNumber } : {}),
    name: {
      first: readNamePart(env, ADMIN_BOOTSTRAP_FIRST_NAME),
      last: readNamePart(env, ADMIN_BOOTSTRAP_LAST_NAME),
    },
  };
}

export async function seedFirstAdmin(
  credentials: AdminBootstrapCredentials,
): Promise<AdminBootstrapResult> {
  const existingByEmail = await userRepository.findByEmail(credentials.email);

  if (existingByEmail) {
    if (existingByEmail.role === 'ADMIN' && existingByEmail.deletedAt == null) {
      return alreadyExistsResult(existingByEmail._id.toString());
    }

    throw new Error('An account with this email already exists.');
  }

  const existingAdmin = await userRepository.findOne({ role: 'ADMIN' });

  if (existingAdmin) {
    return alreadyExistsResult(existingAdmin._id.toString());
  }

  if (!credentials.mobileNumber) {
    throw missingEnv(ADMIN_BOOTSTRAP_MOBILE_NUMBER);
  }

  const passwordHash = await hashPassword(credentials.password);

  try {
    const created = await userRepository.create({
      email: credentials.email,
      passwordHash,
      role: 'ADMIN',
      status: 'ACTIVE',
      name: credentials.name,
      mobileNumber: credentials.mobileNumber,
    });

    getLogger({ module: 'seed-admin' }).info(
      { created: true, userId: created._id.toString() },
      'First admin created',
    );
    return { created: true, userId: created._id.toString() };
  } catch (error) {
    const racedByEmail = await userRepository.findByEmail(credentials.email);
    if (racedByEmail?.role === 'ADMIN' && racedByEmail.deletedAt == null) {
      return alreadyExistsResult(racedByEmail._id.toString());
    }

    const racedAdmin = await userRepository.findOne({ role: 'ADMIN' });
    if (racedAdmin) {
      return alreadyExistsResult(racedAdmin._id.toString());
    }

    if (isMobileNumberDuplicate(error)) {
      remapDuplicateKey(error, mobileAlreadyRegistered());
    }

    remapDuplicateKey(
      error,
      new AppError({
        statusCode: 409,
        code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
        message: 'An account with this email already exists.',
      }),
    );
  }
}
