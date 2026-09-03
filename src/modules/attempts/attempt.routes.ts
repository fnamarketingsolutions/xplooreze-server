import { Router } from 'express';

import { authenticate, authenticateAllowingDisabled } from '../../middleware/authenticate';
import { requireStudent } from '../../middleware/require-role';
import { requestPdfUploadUrlController } from '../submissions/submission.controller';
import {
  claimExamSessionController,
  releaseExamSessionController,
  startAttemptController,
  submitAttemptController,
  updateAttemptAnswersController,
} from './attempt.controller';

export const attemptRouter = Router();

attemptRouter.post('/', authenticate, requireStudent, startAttemptController);
attemptRouter.post(
  '/:attemptId/session/claim',
  authenticateAllowingDisabled,
  requireStudent,
  claimExamSessionController,
);
attemptRouter.delete(
  '/:attemptId/session',
  authenticateAllowingDisabled,
  requireStudent,
  releaseExamSessionController,
);
attemptRouter.patch(
  '/:attemptId/answers',
  authenticateAllowingDisabled,
  requireStudent,
  updateAttemptAnswersController,
);
attemptRouter.post(
  '/:attemptId/upload-url',
  authenticateAllowingDisabled,
  requireStudent,
  requestPdfUploadUrlController,
);
attemptRouter.post(
  '/:attemptId/submit',
  authenticateAllowingDisabled,
  requireStudent,
  submitAttemptController,
);
