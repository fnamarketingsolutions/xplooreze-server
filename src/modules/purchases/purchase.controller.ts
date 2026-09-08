import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import {
  hashIdempotencyRequest,
  IDEMPOTENCY_OPERATIONS,
  readRequiredIdempotencyKey,
} from '../../shared/http/idempotency';
import { parsePagination } from '../../shared/http/pagination';
import { runIdempotentOperation } from '../idempotency/idempotency.service';
import {
  createPaidPurchase,
  getAdminPurchase,
  getAdminPurchaseReceipt,
  getStudentPendingPurchaseCheckout,
  getStudentPurchase,
  getStudentPurchaseReceipt,
  listAdminPurchases,
  listStudentPurchases,
} from './purchase.service';
import {
  parseAdminPurchaseListQuery,
  parseCreatePurchaseInput,
  parsePurchaseId,
} from './purchase.validation';

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

export async function createPurchaseController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  const idempotencyKey = readRequiredIdempotencyKey(req);
  const input = parseCreatePurchaseInput(req.body);
  const checkout = await runIdempotentOperation({
    userId: studentId,
    operation: IDEMPOTENCY_OPERATIONS.PURCHASES_CREATE,
    key: idempotencyKey,
    requestHash: hashIdempotencyRequest({ testSeriesId: input.testSeriesId }),
    successStatusCode: 201,
    execute: () => createPaidPurchase(studentId, input),
  });

  res.status(checkout.statusCode).json({
    success: true,
    data: checkout.data,
  });
}

export async function listPurchasesController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  const result = await listStudentPurchases(studentId, parsePagination(req.query));

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getPurchaseController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  const purchase = await getStudentPurchase(studentId, parsePurchaseId(req.params.purchaseId));

  res.status(200).json({
    success: true,
    data: purchase,
  });
}

function sendReceiptPdf(
  res: Response,
  file: { filename: string; body: Buffer },
): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Content-Length', String(file.body.length));
  res.send(file.body);
}

export async function downloadStudentPurchaseReceiptController(
  req: Request,
  res: Response,
): Promise<void> {
  const studentId = requireAuthUserId(req);
  const file = await getStudentPurchaseReceipt(
    studentId,
    parsePurchaseId(req.params.purchaseId),
  );
  sendReceiptPdf(res, file);
}

export async function getPurchaseCheckoutController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  const checkout = await getStudentPendingPurchaseCheckout(
    studentId,
    parsePurchaseId(req.params.purchaseId),
  );

  res.status(200).json({
    success: true,
    data: checkout,
  });
}

export async function listAdminPurchasesController(req: Request, res: Response): Promise<void> {
  const result = await listAdminPurchases(
    parsePagination(req.query),
    parseAdminPurchaseListQuery(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function downloadAdminPurchaseReceiptController(
  req: Request,
  res: Response,
): Promise<void> {
  const file = await getAdminPurchaseReceipt(parsePurchaseId(req.params.purchaseId));
  sendReceiptPdf(res, file);
}

export async function getAdminPurchaseController(req: Request, res: Response): Promise<void> {
  const purchase = await getAdminPurchase(parsePurchaseId(req.params.purchaseId));

  res.status(200).json({
    success: true,
    data: purchase,
  });
}
