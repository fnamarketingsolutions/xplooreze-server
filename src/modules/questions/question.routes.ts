import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import {
  createQuestionController,
  deleteQuestionController,
  getAdminQuestionController,
  listAdminQuestionsController,
  updateQuestionController,
} from './question.controller';

export const adminQuestionRouter = Router();

adminQuestionRouter.get('/', authenticate, requireAdmin, listAdminQuestionsController);
adminQuestionRouter.post('/', authenticate, requireAdmin, createQuestionController);
adminQuestionRouter.get('/:questionId', authenticate, requireAdmin, getAdminQuestionController);
adminQuestionRouter.patch('/:questionId', authenticate, requireAdmin, updateQuestionController);
adminQuestionRouter.delete('/:questionId', authenticate, requireAdmin, deleteQuestionController);
