import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import {
  completeAnswerFileUpload,
  completeQuestionPaperUpload,
  deleteAnswerFile,
  listActiveAnswerFiles,
  listActiveQuestionPaper,
  requestAnswerFileUploadUrl,
  requestQuestionPaperUploadUrl,
} from './pdf-files.service';
import {
  parseCompleteUploadBody,
  parseDeleteAnswerFileBody,
  parseDeleteAnswerFileQuery,
  parseFileIdParam,
  parseFileUploadRequest,
  parseTestSeriesIdParam,
} from './pdf-files.validation';

function requireAdmin(req: Request): { userId: string } {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  return { userId: req.auth.userId };
}

type AdminPdfFileLike = {
  _id: { toString(): string };
  testSeriesId: { toString(): string };
  status: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

function toAdminPdfFileDto(file: AdminPdfFileLike) {
  return {
    id: file._id.toString(),
    testSeriesId: file.testSeriesId.toString(),
    status: file.status,
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt.toISOString(),
  };
}

export async function listQuestionPaperController(
  req: Request,
  res: Response,
): Promise<void> {
  requireAdmin(req);
  const testSeriesId = parseTestSeriesIdParam(req.params.testSeriesId);
  const file = await listActiveQuestionPaper(testSeriesId);

  res.status(200).json({
    success: true,
    data: file ? toAdminPdfFileDto(file) : null,
  });
}

export async function listAnswerFilesController(
  req: Request,
  res: Response,
): Promise<void> {
  requireAdmin(req);
  const testSeriesId = parseTestSeriesIdParam(req.params.testSeriesId);
  const files = await listActiveAnswerFiles(testSeriesId);

  res.status(200).json({
    success: true,
    data: files.map(toAdminPdfFileDto),
  });
}

export async function requestQuestionPaperUploadUrlController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = requireAdmin(req);
  const testSeriesId = parseTestSeriesIdParam(req.params.testSeriesId);
  const input = parseFileUploadRequest(req.body);

  const result = await requestQuestionPaperUploadUrl({
    testSeriesId,
    uploadedBy: userId,
    originalName: input.originalName,
    mimeType: input.mimeType,
    claimedSizeBytes: input.claimedSizeBytes,
  });

  res.status(200).json({
    success: true,
    data: {
      fileId: result.file._id.toString(),
      uploadUrl: result.uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      expiresAt: result.expiresAt.toISOString(),
    },
  });
}

export async function completeQuestionPaperUploadController(
  req: Request,
  res: Response,
): Promise<void> {
  requireAdmin(req);
  const testSeriesId = parseTestSeriesIdParam(req.params.testSeriesId);
  const fileId = parseFileIdParam(req.params.fileId);
  parseCompleteUploadBody(req.body);

  const file = await completeQuestionPaperUpload({ testSeriesId, fileId });

  res.status(200).json({
    success: true,
    data: toAdminPdfFileDto(file!),
  });
}

export async function requestAnswerFileUploadUrlController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = requireAdmin(req);
  const testSeriesId = parseTestSeriesIdParam(req.params.testSeriesId);
  const input = parseFileUploadRequest(req.body);

  const result = await requestAnswerFileUploadUrl({
    testSeriesId,
    uploadedBy: userId,
    originalName: input.originalName,
    mimeType: input.mimeType,
    claimedSizeBytes: input.claimedSizeBytes,
  });

  res.status(200).json({
    success: true,
    data: {
      fileId: result.file._id.toString(),
      uploadUrl: result.uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      expiresAt: result.expiresAt.toISOString(),
    },
  });
}

export async function completeAnswerFileUploadController(
  req: Request,
  res: Response,
): Promise<void> {
  requireAdmin(req);
  const testSeriesId = parseTestSeriesIdParam(req.params.testSeriesId);
  const fileId = parseFileIdParam(req.params.fileId);
  parseCompleteUploadBody(req.body);

  const file = await completeAnswerFileUpload({ testSeriesId, fileId });

  res.status(200).json({
    success: true,
    data: toAdminPdfFileDto(file!),
  });
}

export async function deleteAnswerFileController(req: Request, res: Response): Promise<void> {
  requireAdmin(req);
  const fileId = parseFileIdParam(req.params.fileId);
  parseDeleteAnswerFileQuery(req.query);
  parseDeleteAnswerFileBody(req.body);

  const file = await deleteAnswerFile(fileId);

  res.status(200).json({
    success: true,
    data: toAdminPdfFileDto(file),
  });
}
