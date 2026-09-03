import type { NextFunction, Request, Response } from 'express';

import { getConfig } from '../config/index';
import { AppError, ErrorCodes } from '../shared/errors/app-error';

function originFromReferer(referer: string | undefined): string | undefined {
  if (!referer) {
    return undefined;
  }

  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction): void {
  const allowed = getConfig().env.corsOrigin;
  const origin = req.get('origin') ?? originFromReferer(req.get('referer'));

  if (origin) {
    if (!allowed.includes(origin)) {
      throw new AppError({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
        message: 'Request origin is not allowed.',
      });
    }

    next();
    return;
  }

  if (getConfig().env.nodeEnv !== 'production') {
    next();
    return;
  }

  throw new AppError({
    statusCode: 403,
    code: ErrorCodes.FORBIDDEN,
    message: 'Request origin is not allowed.',
  });
}
