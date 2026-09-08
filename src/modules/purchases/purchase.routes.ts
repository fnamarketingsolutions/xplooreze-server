import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin, requireStudent } from '../../middleware/require-role';
import {
  createPurchaseController,
  downloadAdminPurchaseReceiptController,
  getAdminPurchaseController,
  listAdminPurchasesController,
} from './purchase.controller';

export const purchaseRouter = Router();
export const adminPurchaseRouter = Router();

purchaseRouter.post('/', authenticate, requireStudent, createPurchaseController);

adminPurchaseRouter.get('/', authenticate, requireAdmin, listAdminPurchasesController);
adminPurchaseRouter.get(
  '/:purchaseId/receipt',
  authenticate,
  requireAdmin,
  downloadAdminPurchaseReceiptController,
);
adminPurchaseRouter.get('/:purchaseId', authenticate, requireAdmin, getAdminPurchaseController);
