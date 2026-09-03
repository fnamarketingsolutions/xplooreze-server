import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import {
  createEvaluatorCategoryAssignmentController,
  listEvaluatorCategoryAssignmentsController,
  listGroupedEvaluatorCategoryAssignmentsController,
  updateEvaluatorCategoryAssignmentController,
} from './evaluator-assignment.controller';

export const adminEvaluatorAssignmentRouter = Router();

adminEvaluatorAssignmentRouter.get(
  '/',
  authenticate,
  requireAdmin,
  listEvaluatorCategoryAssignmentsController,
);
adminEvaluatorAssignmentRouter.get(
  '/grouped',
  authenticate,
  requireAdmin,
  listGroupedEvaluatorCategoryAssignmentsController,
);
adminEvaluatorAssignmentRouter.post(
  '/',
  authenticate,
  requireAdmin,
  createEvaluatorCategoryAssignmentController,
);
adminEvaluatorAssignmentRouter.patch(
  '/:assignmentId',
  authenticate,
  requireAdmin,
  updateEvaluatorCategoryAssignmentController,
);
