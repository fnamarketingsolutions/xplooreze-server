import type { NextFunction, Request, Response } from 'express';

import { mapPersistenceError } from '../database/errors';
import { AppError, ErrorCodes } from '../shared/errors/app-error';
import { getLogger } from '../shared/logger/logger';

type ErrorBody = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

function toClientError(
  err: unknown,
  isProduction: boolean,
): {
  statusCode: number;
  body: ErrorBody;
  logPayload: Record<string, unknown>;
} {
  const operational = err instanceof AppError ? err : mapPersistenceError(err);

  if (operational) {
    return {
      statusCode: operational.statusCode,
      body: {
        success: false,
        error: {
          code: operational.code,
          message: operational.message,
          ...(operational.details !== undefined ? { details: operational.details } : {}),
        },
      },
      logPayload: {
        errorCode: operational.code,
        statusCode: operational.statusCode,
        message: operational.message,
        cause: operational.cause,
        stack: operational.stack,
      },
    };
  }

  const unexpected = err instanceof Error ? err : new Error('Unknown error');

  return {
    statusCode: 500,
    body: {
      success: false,
      error: {
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: isProduction ? 'An unexpected error occurred.' : unexpected.message,
      },
    },
    logPayload: {
      errorCode: ErrorCodes.INTERNAL_SERVER_ERROR,
      statusCode: 500,
      message: unexpected.message,
      stack: unexpected.stack,
    },
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const { statusCode, body, logPayload } = toClientError(err, isProduction);
  const logger = getLogger({ requestId: req.requestId });

  if (statusCode >= 500) {
    logger.error(logPayload, 'Request failed with server error');
  } else {
    logger.warn(logPayload, 'Request failed with client error');
  }

  res.status(statusCode).json(body);
}
