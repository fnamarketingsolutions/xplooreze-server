import type { Request, Response } from 'express';

import { getConfig, parseTtlToMs, requireAuthConfig } from '../../config/index';

export function setRefreshCookie(res: Response, refreshToken: string): void {
  const auth = requireAuthConfig(getConfig().auth);

  res.cookie(auth.cookie.name, refreshToken, {
    httpOnly: true,
    secure: auth.cookie.secure,
    sameSite: auth.cookie.sameSite,
    path: auth.cookie.path,
    maxAge: parseTtlToMs(auth.refreshTokenTtl, 'JWT_REFRESH_TOKEN_TTL'),
  });
}

export function clearRefreshCookie(res: Response): void {
  const auth = requireAuthConfig(getConfig().auth);

  res.clearCookie(auth.cookie.name, {
    httpOnly: true,
    secure: auth.cookie.secure,
    sameSite: auth.cookie.sameSite,
    path: auth.cookie.path,
  });
}

export function readRefreshCookie(req: Request): string | undefined {
  const auth = requireAuthConfig(getConfig().auth);
  const value = req.cookies?.[auth.cookie.name];

  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  return value;
}
