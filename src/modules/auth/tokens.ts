import { createHash, randomBytes, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { getConfig, requireAuthConfig } from '../../config/index';
import type { UserRole } from '../../database/models/enums';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';

export const ACCESS_TOKEN_TYPE = 'access';

export type AccessTokenClaims = {
  sub: string;
  role: UserRole;
  type: typeof ACCESS_TOKEN_TYPE;
  sessionId: string;
};

export function createRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createPasswordResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionFamilyId(): string {
  return randomUUID();
}

export function issueAccessToken(claims: Omit<AccessTokenClaims, 'type'>): string {
  const auth = requireAuthConfig(getConfig().auth);

  return jwt.sign(
    {
      sub: claims.sub,
      role: claims.role,
      type: ACCESS_TOKEN_TYPE,
      sessionId: claims.sessionId,
    },
    auth.jwtSecret,
    {
      expiresIn: auth.accessTokenTtl,
      issuer: auth.jwtIssuer,
      audience: auth.jwtAudience,
    } as jwt.SignOptions,
  );
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const auth = requireAuthConfig(getConfig().auth);

  try {
    const payload = jwt.verify(token, auth.jwtSecret, {
      issuer: auth.jwtIssuer,
      audience: auth.jwtAudience,
    });

    if (typeof payload === 'string' || payload.sub == null) {
      throw invalidTokenError();
    }

    const role = payload.role;
    const type = payload.type;
    const sessionId = payload.sessionId;

    if (
      type !== ACCESS_TOKEN_TYPE ||
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      (role !== 'STUDENT' && role !== 'ADMIN' && role !== 'EVALUATOR')
    ) {
      throw invalidTokenError();
    }

    return {
      sub: payload.sub,
      role,
      type,
      sessionId,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCodes.TOKEN_EXPIRED,
        message: 'Access token has expired.',
      });
    }

    throw invalidTokenError();
  }
}

function invalidTokenError(): AppError {
  return new AppError({
    statusCode: 401,
    code: ErrorCodes.INVALID_TOKEN,
    message: 'Authentication required.',
  });
}
