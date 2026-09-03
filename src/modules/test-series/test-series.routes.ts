import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import {
  listAnswerFilesController,
  listQuestionPaperController,
  requestAnswerFileUploadUrlController,
  requestQuestionPaperUploadUrlController,
} from '../files/pdf-files.controller';
import {
  createTestSeriesController,
  deleteTestSeriesController,
  getAdminTestSeriesController,
  getCatalogTestSeriesController,
  listAdminTestSeriesController,
  listCatalogTestSeriesController,
  updateTestSeriesController,
} from './test-series.controller';

export const testSeriesRouter = Router();
export const adminTestSeriesRouter = Router();

testSeriesRouter.get('/', listCatalogTestSeriesController);
testSeriesRouter.get('/:testSeriesId', getCatalogTestSeriesController);

adminTestSeriesRouter.get('/', authenticate, requireAdmin, listAdminTestSeriesController);
adminTestSeriesRouter.post('/', authenticate, requireAdmin, createTestSeriesController);
adminTestSeriesRouter.get(
  '/:testSeriesId',
  authenticate,
  requireAdmin,
  getAdminTestSeriesController,
);
adminTestSeriesRouter.patch(
  '/:testSeriesId',
  authenticate,
  requireAdmin,
  updateTestSeriesController,
);
adminTestSeriesRouter.delete(
  '/:testSeriesId',
  authenticate,
  requireAdmin,
  deleteTestSeriesController,
);

// PDF authoring routes
adminTestSeriesRouter.get(
  '/:testSeriesId/question-files',
  authenticate,
  requireAdmin,
  listQuestionPaperController,
);
adminTestSeriesRouter.post(
  '/:testSeriesId/question-files/upload-url',
  authenticate,
  requireAdmin,
  requestQuestionPaperUploadUrlController,
);
adminTestSeriesRouter.get(
  '/:testSeriesId/answer-files',
  authenticate,
  requireAdmin,
  listAnswerFilesController,
);
adminTestSeriesRouter.post(
  '/:testSeriesId/answer-files/upload-url',
  authenticate,
  requireAdmin,
  requestAnswerFileUploadUrlController,
);
