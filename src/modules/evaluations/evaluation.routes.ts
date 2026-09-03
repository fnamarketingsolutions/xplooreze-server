import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin, requireEvaluator } from '../../middleware/require-role';
import {
  assignEvaluatorController,
  completeEvaluationController,
  finalizeEvaluationController,
  getAdminEvaluationController,
  getEvaluatorEvaluationController,
  getEvaluatorSummaryController,
  listAdminEvaluationsController,
  listEvaluatorEvaluationsController,
  reopenEvaluationController,
  startEvaluationController,
  updateEvaluationController,
} from './evaluation.controller';

export const evaluationRouter = Router();
export const adminEvaluationRouter = Router();

evaluationRouter.get('/', authenticate, requireEvaluator, listEvaluatorEvaluationsController);
evaluationRouter.get('/summary', authenticate, requireEvaluator, getEvaluatorSummaryController);
evaluationRouter.get(
  '/:evaluationId',
  authenticate,
  requireEvaluator,
  getEvaluatorEvaluationController,
);
evaluationRouter.post(
  '/:evaluationId/start',
  authenticate,
  requireEvaluator,
  startEvaluationController,
);
evaluationRouter.patch(
  '/:evaluationId',
  authenticate,
  requireEvaluator,
  updateEvaluationController,
);
evaluationRouter.post(
  '/:evaluationId/complete',
  authenticate,
  requireEvaluator,
  completeEvaluationController,
);

adminEvaluationRouter.get('/', authenticate, requireAdmin, listAdminEvaluationsController);
adminEvaluationRouter.get(
  '/:evaluationId',
  authenticate,
  requireAdmin,
  getAdminEvaluationController,
);
adminEvaluationRouter.post(
  '/:evaluationId/assign',
  authenticate,
  requireAdmin,
  assignEvaluatorController,
);
adminEvaluationRouter.post(
  '/:evaluationId/finalize',
  authenticate,
  requireAdmin,
  finalizeEvaluationController,
);
adminEvaluationRouter.post(
  '/:evaluationId/reopen',
  authenticate,
  requireAdmin,
  reopenEvaluationController,
);
