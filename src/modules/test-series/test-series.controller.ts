import type { Request, Response } from 'express';

import { parsePagination } from '../../shared/http/pagination';
import {
  createTestSeries,
  deleteTestSeries,
  getAdminTestSeries,
  getVisibleTestSeries,
  listAdminTestSeries,
  listVisibleTestSeries,
  updateTestSeries,
} from './test-series.service';
import {
  parseAdminTestSeriesListQuery,
  parseCatalogTestSeriesListQuery,
  parseCreateTestSeriesInput,
  parseTestSeriesId,
  parseUpdateTestSeriesInput,
} from './test-series.validation';

export async function listCatalogTestSeriesController(req: Request, res: Response): Promise<void> {
  const result = await listVisibleTestSeries(
    parseCatalogTestSeriesListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getCatalogTestSeriesController(req: Request, res: Response): Promise<void> {
  const testSeries = await getVisibleTestSeries(parseTestSeriesId(req.params.testSeriesId));

  res.status(200).json({
    success: true,
    data: testSeries,
  });
}

export async function listAdminTestSeriesController(req: Request, res: Response): Promise<void> {
  const result = await listAdminTestSeries(
    parseAdminTestSeriesListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getAdminTestSeriesController(req: Request, res: Response): Promise<void> {
  const testSeries = await getAdminTestSeries(parseTestSeriesId(req.params.testSeriesId));

  res.status(200).json({
    success: true,
    data: testSeries,
  });
}

export async function createTestSeriesController(req: Request, res: Response): Promise<void> {
  const testSeries = await createTestSeries(parseCreateTestSeriesInput(req.body));

  res.status(201).json({
    success: true,
    data: testSeries,
  });
}

export async function updateTestSeriesController(req: Request, res: Response): Promise<void> {
  const testSeries = await updateTestSeries(
    parseTestSeriesId(req.params.testSeriesId),
    parseUpdateTestSeriesInput(req.body),
  );

  res.status(200).json({
    success: true,
    data: testSeries,
  });
}

export async function deleteTestSeriesController(req: Request, res: Response): Promise<void> {
  const testSeries = await deleteTestSeries(parseTestSeriesId(req.params.testSeriesId));

  res.status(200).json({
    success: true,
    data: testSeries,
  });
}
