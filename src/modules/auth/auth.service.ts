import type { ClientSession } from 'mongoose';

import { remapDuplicateKey } from '../../database/errors';
import { getConfig, parseTtlToMs, requireAuthConfig } from '../../config/index';
import {
  auditLogRepository,
  authSessionRepository,
  passwordResetTokenRepository,
  userRepository,
} from '../../database/repositories/index';
import { withTransaction } from '../../database/transactions';
import { renderNotificationEmail } from '../notifications/email-templates';
import { sendEmail } from '../notifications/email.service';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdateOwnMobileNumberInput,
} from './auth.validation';
import { isMobileNumberDuplicate, mobileAlreadyRegistered } from './mobile-number';
import { hashPassword, verifyPassword } from './password';
import {
  createPasswordResetToken,
  createRefreshToken,
  createSessionFamilyId,
  hashPasswordResetToken,
  hashRefreshToken,
  issueAccessToken,
} from './tokens';
import { toSafeUser, type SafeUser } from './user.dto';

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: SafeUser;
};

export type ForgotPasswordResult = {
  message: string;
};

function invalidCredentialsError(): AppError {
  return new AppError({
    statusCode: 401,
    code: ErrorCodes.INVALID_CREDENTIALS,
    message: 'Invalid email or password.',
  });
}

function invalidRefreshError(): AppError {
  return new AppError({
    statusCode: 401,
    code: ErrorCodes.INVALID_REFRESH_TOKEN,
    message: 'Refresh token is invalid or expired.',
  });
}

function invalidPasswordResetTokenError(): AppError {
  return new AppError({
    statusCode: 401,
    code: ErrorCodes.INVALID_PASSWORD_RESET_TOKEN,
    message: 'Reset token is invalid or expired.',
  });
}

function passwordResetConfigurationError(message: string, cause?: unknown): AppError {
  return new AppError({
    statusCode: 500,
    code: ErrorCodes.PASSWORD_RESET_CONFIGURATION_INVALID,
    message,
    cause,
  });
}

function sessionLifetimeMs(): number {
  const auth = requireAuthConfig(getConfig().auth);
  return parseTtlToMs(auth.refreshTokenTtl, 'JWT_REFRESH_TOKEN_TTL');
}

function passwordResetLifetimeMs(): number {
  const auth = requireAuthConfig(getConfig().auth);
  return parseTtlToMs(auth.passwordResetTokenTtl, 'PASSWORD_RESET_TOKEN_TTL');
}

function getPasswordResetUrlBase(): string {
  const value = getConfig().auth.passwordResetUrlBase;

  if (!value) {
    throw passwordResetConfigurationError('Password reset URL configuration is missing.');
  }

  try {
    return new URL(value).toString();
  } catch (error) {
    throw passwordResetConfigurationError('Password reset URL configuration is invalid.', error);
  }
}

function buildPasswordResetUrl(token: string): string {
  const url = new URL(getPasswordResetUrlBase());
  url.searchParams.set('token', token);
  return url.toString();
}

async function writePasswordResetAudit(
  action: 'PASSWORD_RESET_REQUESTED' | 'PASSWORD_CHANGED',
  user: { _id: { toString(): string }; role: SafeUser['role'] },
  metadata: Record<string, unknown>,
  session?: { session: ClientSession },
): Promise<void> {
  await auditLogRepository.create(
    {
      actorUserId: user._id,
      actorRole: user.role,
      action,
      resource: { type: 'User', id: user._id },
      metadata,
    },
    session,
  );
}

async function issueSession(user: {
  _id: { toString(): string };
  email: string;
  role: SafeUser['role'];
  status: SafeUser['status'];
  name: SafeUser['name'];
}): Promise<AuthResult> {
  const refreshToken = createRefreshToken();
  const now = new Date();
  const session = await authSessionRepository.create({
    userId: user._id,
    familyId: createSessionFamilyId(),
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(now.getTime() + sessionLifetimeMs()),
    lastUsedAt: now,
    revokedAt: null,
  });

  return {
    accessToken: issueAccessToken({
      sub: user._id.toString(),
      role: user.role,
      sessionId: session._id.toString(),
    }),
    refreshToken,
    user: toSafeUser(user),
  };
}

function emailAlreadyRegistered(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
    message: 'An account with this email already exists.',
  });
}

function remapUserUniqueConflict(error: unknown): never {
  if (isMobileNumberDuplicate(error)) {
    remapDuplicateKey(error, mobileAlreadyRegistered());
  }

  remapDuplicateKey(error, emailAlreadyRegistered());
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await userRepository.findByEmail(input.email);

  if (existing) {
    throw emailAlreadyRegistered();
  }

  const existingMobile = await userRepository.findByMobileNumber(input.mobileNumber);

  if (existingMobile) {
    throw mobileAlreadyRegistered();
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await userRepository.create({
      email: input.email,
      passwordHash,
      role: 'STUDENT',
      status: 'ACTIVE',
      name: input.name,
      mobileNumber: input.mobileNumber,
    });

    return issueSession(user);
  } catch (error) {
    remapUserUniqueConflict(error);
  }
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await userRepository.findByEmail(input.email);

  if (!user || user.status !== 'ACTIVE') {
    throw invalidCredentialsError();
  }

  const passwordMatches = await verifyPassword(user.passwordHash, input.password);

  if (!passwordMatches) {
    throw invalidCredentialsError();
  }

  return issueSession(user);
}

export async function refresh(refreshToken: string | undefined): Promise<AuthResult> {
  if (!refreshToken) {
    throw invalidRefreshError();
  }

  const refreshTokenHash = hashRefreshToken(refreshToken);
  const session = await authSessionRepository.findByRefreshTokenHash(refreshTokenHash);

  if (!session) {
    throw invalidRefreshError();
  }

  const now = new Date();

  if (session.revokedAt) {
    await authSessionRepository.revokeFamily(session.familyId, now);
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.SESSION_REVOKED,
      message: 'Refresh token is invalid or expired.',
    });
  }

  if (session.expiresAt.getTime() <= now.getTime()) {
    await authSessionRepository.revokeIfActive(session._id, now);
    throw invalidRefreshError();
  }

  const user = await userRepository.findById(session.userId);

  if (!user || user.deletedAt != null || user.status !== 'ACTIVE') {
    await authSessionRepository.revokeFamily(session.familyId, now);
    throw invalidRefreshError();
  }

  const nextRefreshToken = createRefreshToken();
  const nextSession = await authSessionRepository.create({
    userId: user._id,
    familyId: session.familyId,
    refreshTokenHash: hashRefreshToken(nextRefreshToken),
    expiresAt: new Date(now.getTime() + sessionLifetimeMs()),
    lastUsedAt: now,
    revokedAt: null,
  });

  const replaced = await authSessionRepository.markReplaced(session._id, nextSession._id, now);

  if (!replaced) {
    await authSessionRepository.revokeFamily(session.familyId, now);
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.SESSION_REVOKED,
      message: 'Refresh token is invalid or expired.',
    });
  }

  return {
    accessToken: issueAccessToken({
      sub: user._id.toString(),
      role: user.role,
      sessionId: nextSession._id.toString(),
    }),
    refreshToken: nextRefreshToken,
    user: toSafeUser(user),
  };
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) {
    return;
  }

  const session = await authSessionRepository.findByRefreshTokenHash(
    hashRefreshToken(refreshToken),
  );

  if (!session || session.revokedAt) {
    return;
  }

  await authSessionRepository.revokeFamily(session.familyId, new Date());
}

export async function forgotPassword(input: ForgotPasswordInput): Promise<ForgotPasswordResult> {
  const logger = getLogger({ module: 'auth', event: 'PASSWORD_RESET_REQUESTED' });
  getPasswordResetUrlBase();

  const user = await userRepository.findByEmail(input.email);

  if (!user || user.deletedAt != null || user.status !== 'ACTIVE') {
    return {
      message: 'If an account exists for this email, password reset instructions have been sent.',
    };
  }

  const rawToken = createPasswordResetToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + passwordResetLifetimeMs());

  await withTransaction(async (session) => {
    await passwordResetTokenRepository.create(
      {
        userId: user._id,
        tokenHash: hashPasswordResetToken(rawToken),
        expiresAt,
      },
      { session },
    );

    await writePasswordResetAudit(
      'PASSWORD_RESET_REQUESTED',
      user,
      { expiresAt, channel: 'email' },
      { session },
    );
  });

  const resetUrl = buildPasswordResetUrl(rawToken);
  const expiresInMinutes = Math.round(passwordResetLifetimeMs() / 60_000);
  const email = renderNotificationEmail('PASSWORD_RESET_REQUESTED', {
    resetUrl,
    expiresInMinutes,
  });

  try {
    await sendEmail({
      to: user.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  } catch (error) {
    logger.error(
      {
        userId: user._id.toString(),
        email: user.email,
        errorCode: error instanceof AppError ? error.code : undefined,
      },
      'Password reset email delivery failed after token creation',
    );
  }

  return {
    message: 'If an account exists for this email, password reset instructions have been sent.',
  };
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const now = new Date();
  const tokenHash = hashPasswordResetToken(input.token);

  await withTransaction(async (session) => {
    const resetToken = await passwordResetTokenRepository.consumeAvailableToken(tokenHash, now, {
      session,
    });

    if (!resetToken) {
      throw invalidPasswordResetTokenError();
    }

    const user = await userRepository.findById(resetToken.userId, { session });

    if (!user || user.deletedAt != null || user.status !== 'ACTIVE') {
      throw invalidPasswordResetTokenError();
    }

    const passwordHash = await hashPassword(input.password);

    await userRepository.updateById(
      user._id,
      {
        $set: {
          passwordHash,
        },
      },
      { session },
    );

    await authSessionRepository.revokeAllForUser(user._id, now, { session });
    await passwordResetTokenRepository.invalidateAllForUser(user._id, now, { session });
    await writePasswordResetAudit(
      'PASSWORD_CHANGED',
      user,
      { source: 'password_reset' },
      { session },
    );
  });
}

export async function updateOwnMobileNumber(
  userId: string,
  input: UpdateOwnMobileNumberInput,
): Promise<SafeUser> {
  const user = await userRepository.findById(userId);

  if (!user || user.deletedAt != null) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  if (user.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 403,
      code: ErrorCodes.ACCOUNT_DISABLED,
      message: 'Account is disabled.',
    });
  }

  if (user.mobileNumber === input.mobileNumber) {
    return toSafeUser(user);
  }

  const existingMobile = await userRepository.findByMobileNumber(input.mobileNumber);

  if (existingMobile && existingMobile._id.toString() !== userId) {
    throw mobileAlreadyRegistered();
  }

  try {
    const updated = await userRepository.updateById(userId, {
      $set: { mobileNumber: input.mobileNumber },
    });

    if (!updated || updated.deletedAt != null) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCodes.AUTHENTICATION_REQUIRED,
        message: 'Authentication required.',
      });
    }

    return toSafeUser(updated);
  } catch (error) {
    remapUserUniqueConflict(error);
  }
}

export async function getAuthenticatedUser(userId: string): Promise<SafeUser> {
  const user = await userRepository.findById(userId);

  if (!user || user.deletedAt != null) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  if (user.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 403,
      code: ErrorCodes.ACCOUNT_DISABLED,
      message: 'Account is disabled.',
    });
  }

  return toSafeUser(user);
}
