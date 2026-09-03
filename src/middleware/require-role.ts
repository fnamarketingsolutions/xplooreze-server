import type { NextFunction, Request, Response } from 'express';

import type { UserRole } from '../database/models/enums';
import { AppError, ErrorCodes } from '../shared/errors/app-error';

export function requireRole(role: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCodes.AUTHENTICATION_REQUIRED,
        message: 'Authentication required.',
      });
    }

    if (req.auth.role !== role) {
      throw new AppError({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
        message: 'You are not allowed to perform this operation.',
      });
    }

    next();
  };
}

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCodes.AUTHENTICATION_REQUIRED,
        message: 'Authentication required.',
      });
    }

    if (!roles.includes(req.auth.role)) {
      throw new AppError({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
        message: 'You are not allowed to perform this operation.',
      });
    }

    next();
  };
}

export const requireStudent = requireRole('STUDENT');
export const requireEvaluator = requireRole('EVALUATOR');
export const requireAdmin = requireRole('ADMIN');
export const requireStudentEvaluatorOrAdmin = requireRoles('STUDENT', 'EVALUATOR', 'ADMIN');
