import type { Request, Response } from 'express';

import { parsePagination } from '../../shared/http/pagination';
import {
  createModule,
  deleteModule,
  getAdminModule,
  getVisibleModule,
  listAdminModules,
  listVisibleModules,
  updateModule,
} from './module.service';
import {
  parseAdminModuleListQuery,
  parseCatalogModuleListQuery,
  parseCreateModuleInput,
  parseModuleId,
  parseUpdateModuleInput,
} from './module.validation';

export async function listCatalogModulesController(req: Request, res: Response): Promise<void> {
  const result = await listVisibleModules(
    parseCatalogModuleListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getCatalogModuleController(req: Request, res: Response): Promise<void> {
  const module = await getVisibleModule(parseModuleId(req.params.moduleId));

  res.status(200).json({
    success: true,
    data: module,
  });
}

export async function listAdminModulesController(req: Request, res: Response): Promise<void> {
  const result = await listAdminModules(
    parseAdminModuleListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getAdminModuleController(req: Request, res: Response): Promise<void> {
  const module = await getAdminModule(parseModuleId(req.params.moduleId));

  res.status(200).json({
    success: true,
    data: module,
  });
}

export async function createModuleController(req: Request, res: Response): Promise<void> {
  const module = await createModule(parseCreateModuleInput(req.body));

  res.status(201).json({
    success: true,
    data: module,
  });
}

export async function updateModuleController(req: Request, res: Response): Promise<void> {
  const module = await updateModule(
    parseModuleId(req.params.moduleId),
    parseUpdateModuleInput(req.body),
  );

  res.status(200).json({
    success: true,
    data: module,
  });
}

export async function deleteModuleController(req: Request, res: Response): Promise<void> {
  const module = await deleteModule(parseModuleId(req.params.moduleId));

  res.status(200).json({
    success: true,
    data: module,
  });
}
