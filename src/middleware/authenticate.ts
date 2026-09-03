import type { NextFunction, Request, Response } from 'express';

import { userRepository } from '../database/repositories/index';
import { verifyAccessToken } from '../modules/auth/tokens';
import { accountDisabledError, AppError, ErrorCodes } from '../shared/errors/app-error';

function authenticationRequired(): AppError {
  return new AppError({
    statusCode: 401,
    code: ErrorCodes.AUTHENTICATION_REQUIRED,
    message: 'Authentication required.',
  });
}

type AuthenticateOptions = {
  allowDisabled?: boolean;
};

function createAuthenticate(options: AuthenticateOptions = {}) {
  return async function authenticate(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const header = req.get('authorization');

    if (!header) {
      throw authenticationRequired();
    }

    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw authenticationRequired();
    }

    const claims = verifyAccessToken(token);
    const user = await userRepository.findById(claims.sub);

    if (!user || user.deletedAt != null) {
      throw authenticationRequired();
    }

    if (user.status !== 'ACTIVE' && !options.allowDisabled) {
      throw accountDisabledError();
    }

    req.auth = {
      userId: user._id.toString(),
      role: user.role,
      status: user.status,
      sessionId: claims.sessionId,
    };

    next();
  };
}

export const authenticate = createAuthenticate();
export const authenticateAllowingDisabled = createAuthenticate({ allowDisabled: true });
