import { Types } from 'mongoose';

import { PDF_SUBMISSION_MAX_SIZE_BYTES } from '../../database/models/conventions';
import type { UserRole, UserStatus } from '../../database/models/enums';
import {
  answerFileRepository,
  attemptRepository,
  evaluationRepository,
  questionFileRepository,
  submissionFileRepository,
  submissionRepository,
} from '../../database/repositories/index';
import {
  bufferStartsWithPdfMagic,
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  getBlobRange,
  headBlob,
  submissionBlobLocator,
} from '../../integrations/blob/index';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';
import { assertActiveOrContinuableAttempt } from '../attempts/attempt-access';
import { assertAssignedEvaluatorForSubmission } from '../evaluations/evaluation.service';
import { toStudentSubmissionFileDto, type SubmissionFileDownloadDto } from './file.dto';

export const PDF_MIME_TYPE = 'application/pdf';

function fileTooLarge(): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.FILE_TOO_LARGE,
    message: 'PDF submission files must be 20 MB or smaller.',
  });
}

function fileTypeNotAllowed(): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
    message: 'PDF submission files must be application/pdf.',
  });
}

function fileUploadIncomplete(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.FILE_UPLOAD_INCOMPLETE,
    message: 'Uploaded file could not be verified.',
  });
}

function fileNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.FILE_NOT_FOUND,
    message: 'File not found.',
  });
}

function fileNotAccessible(): AppError {
  return new AppError({
    statusCode: 403,
    code: ErrorCodes.FILE_NOT_ACCESSIBLE,
    message: 'File is not accessible.',
  });
}

export function isPdfMimeType(value: string): boolean {
  return value.trim().toLowerCase() === PDF_MIME_TYPE;
}

export function displayFileName(originalName: string): string {
  const trimmed = originalName.trim();
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  return base.slice(0, 255);
}

export async function createPendingSubmissionFile(input: {
  attemptId: string;
  uploadedBy: string;
  originalName: string;
  mimeType: string;
  claimedSizeBytes: number;
  now?: Date;
}) {
  if (!isPdfMimeType(input.mimeType)) {
    throw fileTypeNotAllowed();
  }

  if (input.claimedSizeBytes > PDF_SUBMISSION_MAX_SIZE_BYTES) {
    throw fileTooLarge();
  }

  const originalName = displayFileName(input.originalName);
  const fileId = new Types.ObjectId();
  const storageLocator = submissionBlobLocator(fileId.toString());

  const file = await submissionFileRepository.create({
    _id: fileId,
    attemptId: input.attemptId,
    submissionId: null,
    status: 'PENDING',
    storageProvider: 'VERCEL_BLOB',
    storageLocator,
    originalName,
    mimeType: PDF_MIME_TYPE,
    sizeBytes: input.claimedSizeBytes,
    uploadedBy: input.uploadedBy,
  });

  const presigned = await createPresignedUploadUrl({
    locator: storageLocator,
    contentType: PDF_MIME_TYPE,
    maximumSizeInBytes: PDF_SUBMISSION_MAX_SIZE_BYTES,
    now: input.now,
  });

  getLogger({ module: 'files', event: 'FILE_UPLOAD_AUTHORIZED' }).info(
    { fileId, attemptId: input.attemptId, sizeBytes: input.claimedSizeBytes },
    'PDF upload authorized',
  );

  return {
    file,
    uploadUrl: presigned.url,
    expiresAt: presigned.expiresAt,
  };
}

export async function verifyUploadedSubmissionObject(file: {
  _id: { toString(): string };
  storageLocator: string;
  mimeType: string;
  status: string;
}) {
  const metadata = await headBlob(file.storageLocator);

  if (!metadata || metadata.contentLength == null) {
    getLogger({ module: 'files', event: 'FILE_UPLOAD_FAILED' }).warn(
      { fileId: file._id.toString() },
      'Blob object missing at upload confirmation',
    );
    throw fileUploadIncomplete();
  }

  if (metadata.contentLength > PDF_SUBMISSION_MAX_SIZE_BYTES) {
    throw fileTooLarge();
  }

  if (metadata.contentLength < 1) {
    throw fileUploadIncomplete();
  }

  const declaredType = metadata.contentType?.split(';')[0]?.trim().toLowerCase();

  if (declaredType && declaredType !== PDF_MIME_TYPE) {
    throw fileTypeNotAllowed();
  }

  const prefix = await getBlobRange(file.storageLocator, 0, 4);

  if (!prefix || !bufferStartsWithPdfMagic(prefix)) {
    throw fileTypeNotAllowed();
  }

  return {
    sizeBytes: metadata.contentLength,
    mimeType: PDF_MIME_TYPE,
  };
}

export function toUploadAuthorizationDto(
  file: Parameters<typeof toStudentSubmissionFileDto>[0],
  uploadUrl: string,
  expiresAt: Date,
) {
  return {
    fileId: file._id.toString(),
    uploadUrl,
    method: 'PUT' as const,
    headers: { 'Content-Type': PDF_MIME_TYPE },
    expiresAt: expiresAt.toISOString(),
    file: toStudentSubmissionFileDto(file),
  };
}

async function resolveSubmissionIdForFile(file: {
  submissionId?: { toString(): string } | null;
  attemptId?: { toString(): string } | null;
}): Promise<string | null> {
  if (file.submissionId) {
    return file.submissionId.toString();
  }

  if (!file.attemptId) {
    return null;
  }

  const submission = await submissionRepository.findByAttemptId(file.attemptId.toString());
  return submission ? submission._id.toString() : null;
}

async function authorizeSubmissionFileDownload(input: {
  file: {
    _id: { toString(): string };
    attemptId?: { toString(): string } | null;
    submissionId?: { toString(): string } | null;
  };
  userId: string;
  role: UserRole;
  accountStatus: UserStatus;
}): Promise<void> {
  if (input.role === 'ADMIN') {
    return;
  }

  if (input.role === 'STUDENT') {
    if (!input.file.attemptId) {
      throw fileNotAccessible();
    }

    const attempt = await attemptRepository.findById(input.file.attemptId.toString());

    if (!attempt || attempt.studentId.toString() !== input.userId) {
      throw fileNotAccessible();
    }

    assertActiveOrContinuableAttempt(input.accountStatus, attempt.status);
    return;
  }

  if (input.role === 'EVALUATOR') {
    const submissionId = await resolveSubmissionIdForFile(input.file);

    if (!submissionId) {
      throw fileNotAccessible();
    }

    await assertAssignedEvaluatorForSubmission(input.userId, submissionId);
    return;
  }

  throw new AppError({
    statusCode: 403,
    code: ErrorCodes.FORBIDDEN,
    message: 'You are not allowed to perform this operation.',
  });
}

async function authorizeQuestionFileDownload(input: {
  file: { _id: { toString(): string }; status: string };
  userId: string;
  role: UserRole;
  accountStatus: UserStatus;
}): Promise<void> {
  if (input.role === 'ADMIN') {
    return;
  }

  if (input.role === 'STUDENT') {
    const attempt = await attemptRepository.findOne({
      studentId: input.userId,
      questionPaperFileId: input.file._id.toString(),
      ...(input.accountStatus !== 'ACTIVE'
        ? { status: { $in: ['IN_PROGRESS', 'UPLOAD_PENDING'] } }
        : {}),
    });

    if (!attempt) {
      throw fileNotAccessible();
    }

    if (input.file.status !== 'ACTIVE' && input.file.status !== 'REPLACED') {
      throw fileNotAccessible();
    }

    assertActiveOrContinuableAttempt(input.accountStatus, attempt.status);
    return;
  }

  if (input.role === 'EVALUATOR') {
    const attempts = await attemptRepository.findByQuestionPaperFileId(input.file._id.toString());
    let authorized = false;

    for (const attempt of attempts) {
      const submission = await submissionRepository.findByAttemptId(attempt._id.toString());

      if (!submission) {
        continue;
      }

      try {
        await assertAssignedEvaluatorForSubmission(input.userId, submission._id.toString());
        authorized = true;
        break;
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          (error.code !== ErrorCodes.EVALUATOR_NOT_ASSIGNED &&
            error.code !== ErrorCodes.EVALUATOR_NOT_AUTHORIZED)
        ) {
          throw error;
        }
      }
    }

    if (!authorized) {
      throw fileNotAccessible();
    }
    return;
  }

  throw fileNotAccessible();
}

async function authorizeAnswerFileDownload(input: {
  file: { testSeriesId: { toString(): string } };
  userId: string;
  role: UserRole;
}): Promise<void> {
  if (input.role === 'ADMIN') {
    return;
  }

  if (input.role === 'STUDENT') {
    throw fileNotAccessible();
  }

  if (input.role === 'EVALUATOR') {
    const evaluation = await evaluationRepository.findAssignedForEvaluatorAndTestSeries(
      input.userId,
      input.file.testSeriesId.toString(),
    );

    if (!evaluation) {
      throw fileNotAccessible();
    }

    await assertAssignedEvaluatorForSubmission(input.userId, evaluation.submissionId.toString());
    return;
  }

  throw fileNotAccessible();
}

export async function createFileDownloadUrl(input: {
  fileId: string;
  userId: string;
  role: UserRole;
  accountStatus?: UserStatus;
  now?: Date;
}): Promise<SubmissionFileDownloadDto> {
  const accountStatus = input.accountStatus ?? 'ACTIVE';
  const questionFile = await questionFileRepository.findById(input.fileId);

  if (questionFile && questionFile.deletedAt == null) {
    if (questionFile.status === 'PENDING' || questionFile.status === 'DELETED') {
      throw fileNotAccessible();
    }

    await authorizeQuestionFileDownload({
      file: questionFile,
      userId: input.userId,
      role: input.role,
      accountStatus,
    });

    const fresh = await questionFileRepository.findById(input.fileId);

    if (
      !fresh ||
      fresh.deletedAt != null ||
      fresh.status === 'PENDING' ||
      fresh.status === 'DELETED'
    ) {
      throw fileNotAccessible();
    }

    try {
      const presigned = await createPresignedDownloadUrl({
        locator: fresh.storageLocator,
        now: input.now,
      });
      return { downloadUrl: presigned.url };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError({
        statusCode: 500,
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Unable to generate download URL.',
      });
    }
  }

  const answerFile = await answerFileRepository.findById(input.fileId);

  if (answerFile && answerFile.deletedAt == null) {
    if (answerFile.status !== 'ACTIVE') {
      throw fileNotAccessible();
    }

    await authorizeAnswerFileDownload({
      file: answerFile,
      userId: input.userId,
      role: input.role,
    });

    const fresh = await answerFileRepository.findById(input.fileId);

    if (!fresh || fresh.deletedAt != null || fresh.status !== 'ACTIVE') {
      throw fileNotAccessible();
    }

    try {
      const presigned = await createPresignedDownloadUrl({
        locator: fresh.storageLocator,
        now: input.now,
      });
      return { downloadUrl: presigned.url };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError({
        statusCode: 500,
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Unable to generate download URL.',
      });
    }
  }

  return createSubmissionFileDownloadUrl({ ...input, accountStatus });
}

export async function createSubmissionFileDownloadUrl(input: {
  fileId: string;
  userId: string;
  role: UserRole;
  accountStatus?: UserStatus;
  now?: Date;
}): Promise<SubmissionFileDownloadDto> {
  const file = await submissionFileRepository.findById(input.fileId);

  if (!file || file.deletedAt != null) {
    throw fileNotFound();
  }

  if (file.status !== 'ACTIVE') {
    throw fileNotAccessible();
  }

  await authorizeSubmissionFileDownload({
    file,
    userId: input.userId,
    role: input.role,
    accountStatus: input.accountStatus ?? 'ACTIVE',
  });

  const fresh = await submissionFileRepository.findById(input.fileId);

  if (!fresh || fresh.deletedAt != null || fresh.status !== 'ACTIVE') {
    throw fileNotAccessible();
  }

  try {
    const presigned = await createPresignedDownloadUrl({
      locator: fresh.storageLocator,
      now: input.now,
    });

    return { downloadUrl: presigned.url };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    getLogger({ module: 'files', event: 'FILE_DOWNLOAD_FAILED' }).error(
      { fileId: input.fileId },
      'Failed to generate submission file download URL',
    );

    throw new AppError({
      statusCode: 500,
      code: ErrorCodes.INTERNAL_SERVER_ERROR,
      message: 'Unable to generate download URL.',
    });
  }
}
