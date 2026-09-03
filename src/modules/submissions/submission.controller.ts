import type { Request, Response } from 'express';

import type { UserStatus } from '../../database/models/enums';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { parseAttemptId } from '../attempts/attempt.validation';
import {
  EXAM_SESSION_HEADER,
  parseExamSessionIdHeader,
} from '../attempts/exam-session';
import { completePdfUpload, requestPdfUploadUrl } from './submission.service';
import {
  parseCompleteUploadInput,
  parseFileId,
  parseRequestPdfUploadInput,
} from './submission.validation';

function requireAuth(req: Request): { userId: string; status: UserStatus } {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  return { userId: req.auth.userId, status: req.auth.status };
}

function readExamSessionId(req: Request): string {
  return parseExamSessionIdHeader(req.headers[EXAM_SESSION_HEADER]);
}

export async function requestPdfUploadUrlController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const result = await requestPdfUploadUrl(
    auth.userId,
    parseAttemptId(req.params.attemptId),
    parseRequestPdfUploadInput(req.body),
    auth.status,
    undefined,
    readExamSessionId(req),
  );

  res.status(200).json({
    success: true,
    data: result,
  });
}

export async function completePdfUploadController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  parseCompleteUploadInput(req.body);
  const file = await completePdfUpload(auth.userId, parseFileId(req.params.fileId), auth.status);

  res.status(200).json({
    success: true,
    data: file,
  });
}
