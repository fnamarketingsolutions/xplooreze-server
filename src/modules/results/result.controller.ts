import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { parsePagination } from '../../shared/http/pagination';
import {
  getAdminResult,
  getStudentResult,
  listAdminResults,
  listStudentResults,
} from './result.service';
import {
  parseAdminResultListQuery,
  parseEmptyResultBody,
  parseResultId,
  parseStudentResultListQuery,
} from './result.validation';

function requireAuthUserId(req: Request): string {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  return req.auth.userId;
}

export async function listStudentResultsController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  parseStudentResultListQuery(req.query as Record<string, unknown>);
  parseEmptyResultBody(req.body);
  const result = await listStudentResults(studentId, parsePagination(req.query));

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getStudentResultController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  parseEmptyResultBody(req.body);
  const result = await getStudentResult(studentId, parseResultId(req.params.resultId));

  res.status(200).json({
    success: true,
    data: result,
  });
}

export async function listAdminResultsController(req: Request, res: Response): Promise<void> {
  const query = parseAdminResultListQuery(req.query as Record<string, unknown>);
  parseEmptyResultBody(req.body);
  const result = await listAdminResults(parsePagination(req.query), query);

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getAdminResultController(req: Request, res: Response): Promise<void> {
  parseEmptyResultBody(req.body);
  const result = await getAdminResult(parseResultId(req.params.resultId));

  res.status(200).json({
    success: true,
    data: result,
  });
}
