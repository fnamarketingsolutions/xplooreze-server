import { Router } from 'express';

import { authenticate, authenticateAllowingDisabled } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import { completeFileUploadController, downloadFileController } from './file.controller';
import { deleteAnswerFileController } from './pdf-files.controller';

export const fileRouter = Router();
export const adminAnswerFileRouter = Router();

fileRouter.get('/:fileId/download', authenticateAllowingDisabled, downloadFileController);
fileRouter.post('/:fileId/complete', authenticateAllowingDisabled, completeFileUploadController);

adminAnswerFileRouter.delete('/:fileId', authenticate, requireAdmin, deleteAnswerFileController);
