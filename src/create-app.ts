import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { getConfig } from './config/index';
import { connectDatabase } from './database/index';
import { errorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { requestIdMiddleware } from './middleware/request-id';
import { requestLoggerMiddleware } from './middleware/request-logger';
import { razorpayWebhookRouter } from './modules/payments/payment.routes';
import { apiRouter } from './routes';
import { isVercelRuntime } from './shared/runtime/vercel';

/**
 * Ensures Mongo is connected before request handlers run.
 * Local `server.ts` connects at boot; Vercel has no persistent listen bootstrap.
 */
function ensureDatabaseMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  void connectDatabase()
    .then(() => next())
    .catch(next);
}

export function createApp(): Express {
  const config = getConfig();
  const app = express();

  app.disable('x-powered-by');

  if (isVercelRuntime()) {
    app.use(ensureDatabaseMiddleware);
  }

  app.use(helmet());
  app.use(
    cors({
      origin: config.env.corsOrigin,
      credentials: true,
    }),
  );

  // Razorpay webhook must verify against the exact raw body bytes.
  app.use(
    '/webhooks/razorpay',
    express.raw({ type: '*/*', limit: '1mb' }),
    (req, _res, next) => {
      req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
      next();
    },
    requestIdMiddleware,
    requestLoggerMiddleware,
    razorpayWebhookRouter,
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(requestLoggerMiddleware);

  app.use(apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
