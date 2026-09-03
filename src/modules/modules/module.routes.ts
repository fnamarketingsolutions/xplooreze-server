import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import {
  createModuleController,
  deleteModuleController,
  getAdminModuleController,
  getCatalogModuleController,
  listAdminModulesController,
  listCatalogModulesController,
  updateModuleController,
} from './module.controller';

export const moduleRouter = Router();
export const adminModuleRouter = Router();

moduleRouter.get('/', listCatalogModulesController);
moduleRouter.get('/:moduleId', getCatalogModuleController);

adminModuleRouter.get('/', authenticate, requireAdmin, listAdminModulesController);
adminModuleRouter.post('/', authenticate, requireAdmin, createModuleController);
adminModuleRouter.get('/:moduleId', authenticate, requireAdmin, getAdminModuleController);
adminModuleRouter.patch('/:moduleId', authenticate, requireAdmin, updateModuleController);
adminModuleRouter.delete('/:moduleId', authenticate, requireAdmin, deleteModuleController);
