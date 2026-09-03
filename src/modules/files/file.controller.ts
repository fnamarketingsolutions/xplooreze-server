import type { Request, Response } from 'express';

import {
  answerFileRepository,
  questionFileRepository,
  submissionFileRepository,
} from '../../database/repositories/index';
import type { UserRole, UserStatus } from '../../database/models/enums';
import { accountDisabledError, AppError, ErrorCodes } from '../../shared/errors/app-error';
import { completePdfUpload } from '../submissions/submission.service';
import { completeAnswerFileUpload, completeQuestionPaperUpload } from './pdf-files.service';
import { createFileDownloadUrl } from './file.service';
import { parseDownloadBody, parseDownloadQuery, parseFileId } from './file.validation';

function requireAuth(req: Request): { userId: string; role: UserRole; status: UserStatus } {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  return { userId: req.auth.userId, role: req.auth.role, status: req.auth.status };
}

function assertActiveUnlessStudentContinuingAttempt(auth: {
  role: UserRole;
  status: UserStatus;
}): void {
  if (auth.status === 'ACTIVE') {
    return;
  }

  if (auth.role === 'STUDENT') {
    return;
  }

  throw accountDisabledError();
}

export async function downloadFileController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  assertActiveUnlessStudentContinuingAttempt(auth);
  parseDownloadQuery(req.query);
  parseDownloadBody(req.body);

  const result = await createFileDownloadUrl({
    fileId: parseFileId(req.params.fileId),
    userId: auth.userId,
    role: auth.role,
    accountStatus: auth.status,
  });

  res.status(200).json({
    success: true,
    data: result,
  });
}

export async function completeFileUploadController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  assertActiveUnlessStudentContinuingAttempt(auth);
  const fileId = parseFileId(req.params.fileId);
  parseDownloadBody(req.body);

  const submissionFile = await submissionFileRepository.findById(fileId);

  if (submissionFile && submissionFile.deletedAt == null) {
    if (auth.role !== 'STUDENT') {
      throw new AppError({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
        message: 'You are not allowed to perform this operation.',
      });
    }

    const file = await completePdfUpload(auth.userId, fileId, auth.status);
    res.status(200).json({ success: true, data: file });
    return;
  }

  const questionFile = await questionFileRepository.findById(fileId);

  if (questionFile && questionFile.deletedAt == null) {
    if (auth.role !== 'ADMIN') {
      throw new AppError({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
        message: 'You are not allowed to perform this operation.',
      });
    }

    const file = await completeQuestionPaperUpload({
      testSeriesId: questionFile.testSeriesId.toString(),
      fileId,
    });
    res.status(200).json({
      success: true,
      data: {
        id: file!._id.toString(),
        testSeriesId: file!.testSeriesId.toString(),
        status: file!.status,
        originalName: file!.originalName,
        mimeType: file!.mimeType,
        sizeBytes: file!.sizeBytes,
        createdAt: file!.createdAt.toISOString(),
      },
    });
    return;
  }

  const answerFile = await answerFileRepository.findById(fileId);

  if (answerFile && answerFile.deletedAt == null) {
    if (auth.role !== 'ADMIN') {
      throw new AppError({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
        message: 'You are not allowed to perform this operation.',
      });
    }

    const file = await completeAnswerFileUpload({
      testSeriesId: answerFile.testSeriesId.toString(),
      fileId,
    });
    res.status(200).json({
      success: true,
      data: {
        id: file!._id.toString(),
        testSeriesId: file!.testSeriesId.toString(),
        status: file!.status,
        originalName: file!.originalName,
        mimeType: file!.mimeType,
        sizeBytes: file!.sizeBytes,
        createdAt: file!.createdAt.toISOString(),
      },
    });
    return;
  }

  throw new AppError({
    statusCode: 404,
    code: ErrorCodes.FILE_NOT_FOUND,
    message: 'File not found.',
  });
}
