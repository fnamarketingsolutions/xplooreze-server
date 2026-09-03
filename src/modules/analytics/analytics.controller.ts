import type { Request, Response } from 'express';

import { getAdminAnalyticsOverview } from './analytics.service';

export async function getAdminAnalyticsOverviewController(
  _req: Request,
  res: Response,
): Promise<void> {
  const data = await getAdminAnalyticsOverview();

  res.status(200).json({
    success: true,
    data,
  });
}
