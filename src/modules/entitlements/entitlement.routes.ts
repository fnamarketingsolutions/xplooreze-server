import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import {
  getAdminEntitlementController,
  listAdminEntitlementsController,
} from './entitlement.controller';

export const adminEntitlementRouter = Router();

adminEntitlementRouter.get('/', authenticate, requireAdmin, listAdminEntitlementsController);
adminEntitlementRouter.get(
  '/:entitlementId',
  authenticate,
  requireAdmin,
  getAdminEntitlementController,
);
