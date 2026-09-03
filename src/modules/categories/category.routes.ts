import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/require-role';
import {
  createCategoryController,
  deleteCategoryController,
  getAdminCategoryController,
  getCatalogCategoryController,
  listAdminCategoriesController,
  listCatalogCategoriesController,
  updateCategoryController,
} from './category.controller';

export const categoryRouter = Router();
export const adminCategoryRouter = Router();

categoryRouter.get('/', listCatalogCategoriesController);
categoryRouter.get('/:categoryId', getCatalogCategoryController);

adminCategoryRouter.get('/', authenticate, requireAdmin, listAdminCategoriesController);
adminCategoryRouter.post('/', authenticate, requireAdmin, createCategoryController);
adminCategoryRouter.get('/:categoryId', authenticate, requireAdmin, getAdminCategoryController);
adminCategoryRouter.patch('/:categoryId', authenticate, requireAdmin, updateCategoryController);
adminCategoryRouter.delete('/:categoryId', authenticate, requireAdmin, deleteCategoryController);
