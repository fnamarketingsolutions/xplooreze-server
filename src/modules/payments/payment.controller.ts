import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { processRazorpayWebhook, verifyStudentPayment } from './payment.service';
import { parseVerifyPaymentInput } from './payment.validation';

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

export async function verifyPaymentController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuthUserId(req);
  const result = await verifyStudentPayment(studentId, parseVerifyPaymentInput(req.body));

  res.status(200).json({
    success: true,
    data: result,
  });
}

export async function razorpayWebhookController(req: Request, res: Response): Promise<void> {
  const rawBody = req.rawBody ?? req.body;

  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Webhook raw body is required.',
    });
  }

  const result = await processRazorpayWebhook({
    rawBody,
    signature: req.get('x-razorpay-signature') ?? undefined,
    eventId: req.get('x-razorpay-event-id') ?? undefined,
  });

  res.status(200).json({
    success: true,
    data: result,
  });
}
