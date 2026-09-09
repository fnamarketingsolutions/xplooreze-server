import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import {
  forgotPassword,
  getAuthenticatedUser,
  login,
  logout,
  refresh,
  register,
  resetPassword,
  updateOwnMobileNumber,
} from './auth.service';
import {
  parseForgotPasswordInput,
  parseLoginInput,
  parseRegisterInput,
  parseResetPasswordInput,
  parseUpdateOwnMobileNumberInput,
} from './auth.validation';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';

function authResponse(result: { accessToken: string; user: unknown }) {
  return {
    accessToken: result.accessToken,
    user: result.user,
  };
}

export async function registerController(req: Request, res: Response): Promise<void> {
  const input = parseRegisterInput(req.body);
  const result = await register(input);
  setRefreshCookie(res, result.refreshToken);

  res.status(201).json({
    success: true,
    data: authResponse(result),
  });
}

export async function loginController(req: Request, res: Response): Promise<void> {
  const input = parseLoginInput(req.body);
  const result = await login(input);
  setRefreshCookie(res, result.refreshToken);

  res.status(200).json({
    success: true,
    data: authResponse(result),
  });
}

export async function refreshController(req: Request, res: Response): Promise<void> {
  const result = await refresh(readRefreshCookie(req));
  setRefreshCookie(res, result.refreshToken);

  res.status(200).json({
    success: true,
    data: authResponse(result),
  });
}

export async function logoutController(req: Request, res: Response): Promise<void> {
  await logout(readRefreshCookie(req));
  clearRefreshCookie(res);

  res.status(200).json({
    success: true,
    data: {
      loggedOut: true,
    },
  });
}

export async function forgotPasswordController(req: Request, res: Response): Promise<void> {
  const input = parseForgotPasswordInput(req.body);
  const result = await forgotPassword(input);

  res.status(200).json({
    success: true,
    data: result,
  });
}

export async function resetPasswordController(req: Request, res: Response): Promise<void> {
  const input = parseResetPasswordInput(req.body);
  await resetPassword(input);

  res.status(200).json({
    success: true,
    data: {
      message: 'Password has been reset successfully.',
    },
  });
}

export async function updateMeController(req: Request, res: Response): Promise<void> {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  const user = await updateOwnMobileNumber(
    req.auth.userId,
    parseUpdateOwnMobileNumberInput(req.body),
  );

  res.status(200).json({
    success: true,
    data: {
      user,
    },
  });
}

export async function meController(req: Request, res: Response): Promise<void> {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  const user = await getAuthenticatedUser(req.auth.userId);

  res.status(200).json({
    success: true,
    data: {
      user,
    },
  });
}
