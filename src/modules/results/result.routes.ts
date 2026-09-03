import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import { getAdminResultController, listAdminResultsController } from './result.controller';

export const adminResultRouter = Router();

adminResultRouter.get('/', authenticate, requireAdmin, listAdminResultsController);
adminResultRouter.get('/:resultId', authenticate, requireAdmin, getAdminResultController);
