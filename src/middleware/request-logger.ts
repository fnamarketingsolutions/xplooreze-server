import type { NextFunction, Request, Response } from 'express';

import { getLogger } from '../shared/logger/logger';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  const logger = getLogger({ requestId: req.requestId });

  res.on('finish', () => {
    logger.info(
      {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      },
      'HTTP request completed',
    );
  });

  next();
}
