import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import {
  createAdminUserController,
  getAdminUserController,
  listAdminUsersController,
  updateAdminUserController,
} from './user.controller';

export const adminUserRouter = Router();

adminUserRouter.get('/', authenticate, requireAdmin, listAdminUsersController);
adminUserRouter.post('/', authenticate, requireAdmin, createAdminUserController);
adminUserRouter.get('/:userId', authenticate, requireAdmin, getAdminUserController);
adminUserRouter.patch('/:userId', authenticate, requireAdmin, updateAdminUserController);
