import type { Request, Response } from 'express';

import { isDatabaseReady } from '../../database/index';

export function getHealth(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
    },
  });
}

/**
 * Readiness reflects initialized infrastructure dependencies.
 * Currently checks MongoDB only (the dependency connected at bootstrap).
 */
export function getReady(_req: Request, res: Response): void {
  const mongodb = isDatabaseReady();

  if (!mongodb) {
    res.status(503).json({
      success: false,
      data: {
        status: 'not_ready',
        checks: {
          mongodb: false,
        },
      },
    });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      status: 'ready',
      checks: {
        mongodb: true,
      },
    },
  });
}
