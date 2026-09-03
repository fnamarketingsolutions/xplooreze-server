import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import { getAdminAnalyticsOverviewController } from './analytics.controller';

export const adminAnalyticsRouter = Router();

adminAnalyticsRouter.get(
  '/overview',
  authenticate,
  requireAdmin,
  getAdminAnalyticsOverviewController,
);
