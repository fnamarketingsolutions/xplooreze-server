import { Router } from 'express';

import { authenticate, authenticateAllowingDisabled } from '../../middleware/authenticate';
import { requireStudent } from '../../middleware/require-role';
import {
  getActiveAttemptController,
  getAttemptController,
  listAttemptsController,
} from '../attempts/attempt.controller';
import {
  getEntitlementController,
  listEntitlementsController,
} from '../entitlements/entitlement.controller';
import {
  getPurchaseCheckoutController,
  getPurchaseController,
  listPurchasesController,
} from '../purchases/purchase.controller';
import {
  getStudentResultController,
  listStudentResultsController,
} from '../results/result.controller';

export const meRouter = Router();

meRouter.get('/purchases', authenticate, requireStudent, listPurchasesController);
meRouter.get(
  '/purchases/:purchaseId/checkout',
  authenticate,
  requireStudent,
  getPurchaseCheckoutController,
);
meRouter.get('/purchases/:purchaseId', authenticate, requireStudent, getPurchaseController);

meRouter.get('/entitlements', authenticate, requireStudent, listEntitlementsController);
meRouter.get(
  '/entitlements/:entitlementId',
  authenticate,
  requireStudent,
  getEntitlementController,
);

meRouter.get('/attempts', authenticate, requireStudent, listAttemptsController);
meRouter.get(
  '/attempts/active',
  authenticateAllowingDisabled,
  requireStudent,
  getActiveAttemptController,
);
meRouter.get(
  '/attempts/:attemptId',
  authenticateAllowingDisabled,
  requireStudent,
  getAttemptController,
);

meRouter.get('/results', authenticate, requireStudent, listStudentResultsController);
meRouter.get('/results/:resultId', authenticate, requireStudent, getStudentResultController);
