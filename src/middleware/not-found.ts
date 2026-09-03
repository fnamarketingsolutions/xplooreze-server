import type { NextFunction, Request, Response } from 'express';

import { AppError, ErrorCodes } from '../shared/errors/app-error';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError({
      statusCode: 404,
      code: ErrorCodes.ROUTE_NOT_FOUND,
      message: `Route ${req.method} ${req.path} not found`,
    }),
  );
}
