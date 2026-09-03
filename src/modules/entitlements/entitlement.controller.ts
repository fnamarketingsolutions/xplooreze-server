import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { parsePagination } from '../../shared/http/pagination';
import {
  getAdminEntitlement,
  getStudentEntitlement,
  listAdminEntitlements,
  listStudentEntitlements,
} from './entitlement.service';
import { parseAdminEntitlementListQuery, parseEntitlementId } from './entitlement.validation';

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

export async function listEntitlementsController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  const result = await listStudentEntitlements(studentId, parsePagination(req.query));

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getEntitlementController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  const entitlement = await getStudentEntitlement(
    studentId,
    parseEntitlementId(req.params.entitlementId),
  );

  res.status(200).json({
    success: true,
    data: entitlement,
  });
}

export async function listAdminEntitlementsController(req: Request, res: Response): Promise<void> {
  const result = await listAdminEntitlements(
    parsePagination(req.query),
    parseAdminEntitlementListQuery(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getAdminEntitlementController(req: Request, res: Response): Promise<void> {
  const entitlement = await getAdminEntitlement(parseEntitlementId(req.params.entitlementId));

  res.status(200).json({
    success: true,
    data: entitlement,
  });
}
