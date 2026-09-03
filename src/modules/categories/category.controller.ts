import type { Request, Response } from 'express';

import { parsePagination } from '../../shared/http/pagination';
import {
  createCategory,
  deleteCategory,
  getAdminCategory,
  getVisibleCategory,
  listAdminCategories,
  listVisibleCategories,
  updateCategory,
} from './category.service';
import {
  parseAdminCategoryListQuery,
  parseCategoryId,
  parseCreateCategoryInput,
  parseUpdateCategoryInput,
} from './category.validation';

export async function listCatalogCategoriesController(req: Request, res: Response): Promise<void> {
  const result = await listVisibleCategories(parsePagination(req.query));

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getCatalogCategoryController(req: Request, res: Response): Promise<void> {
  const category = await getVisibleCategory(parseCategoryId(req.params.categoryId));

  res.status(200).json({
    success: true,
    data: category,
  });
}

export async function listAdminCategoriesController(req: Request, res: Response): Promise<void> {
  const result = await listAdminCategories(
    parseAdminCategoryListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getAdminCategoryController(req: Request, res: Response): Promise<void> {
  const category = await getAdminCategory(parseCategoryId(req.params.categoryId));

  res.status(200).json({
    success: true,
    data: category,
  });
}

export async function createCategoryController(req: Request, res: Response): Promise<void> {
  const category = await createCategory(parseCreateCategoryInput(req.body));

  res.status(201).json({
    success: true,
    data: category,
  });
}

export async function updateCategoryController(req: Request, res: Response): Promise<void> {
  const category = await updateCategory(
    parseCategoryId(req.params.categoryId),
    parseUpdateCategoryInput(req.body),
  );

  res.status(200).json({
    success: true,
    data: category,
  });
}

export async function deleteCategoryController(req: Request, res: Response): Promise<void> {
  const category = await deleteCategory(parseCategoryId(req.params.categoryId));

  res.status(200).json({
    success: true,
    data: category,
  });
}
