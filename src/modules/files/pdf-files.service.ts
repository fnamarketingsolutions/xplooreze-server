import { Types } from 'mongoose';

import { PDF_SUBMISSION_MAX_SIZE_BYTES } from '../../database/models/conventions';
import {
  answerFileRepository,
  questionFileRepository,
  testSeriesRepository,
} from '../../database/repositories/index';
import { withTransaction } from '../../database/transactions';
import {
  answerBlobLocator,
  bufferStartsWithPdfMagic,
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  getBlobRange,
  headBlob,
  questionBlobLocator,
} from '../../integrations/blob/index';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';
import { displayFileName, isPdfMimeType, PDF_MIME_TYPE } from './file.service';

function testSeriesNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.TEST_SERIES_NOT_FOUND,
    message: 'Test series not found.',
  });
}

function questionPaperNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.QUESTION_PAPER_NOT_FOUND,
    message: 'Question paper not found.',
  });
}

function fileTypeNotAllowed(): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
    message: 'Only PDF files are allowed.',
  });
}

function fileTooLarge(): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.FILE_TOO_LARGE,
    message: 'File must be 20 MB or smaller.',
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

async function verifyUploadedObject(storageLocator: string, fileId: string) {
  const metadata = await headBlob(storageLocator);

  if (!metadata || metadata.contentLength == null) {
    getLogger({ module: 'files', event: 'FILE_UPLOAD_FAILED' }).warn(
      { fileId },
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

  const prefix = await getBlobRange(storageLocator, 0, 4);

  if (!prefix || !bufferStartsWithPdfMagic(prefix)) {
    throw fileTypeNotAllowed();
  }

  return {
    sizeBytes: metadata.contentLength,
    mimeType: PDF_MIME_TYPE,
  };
}

async function requirePdfTestSeries(testSeriesId: string, message: string) {
  const testSeries = await testSeriesRepository.findById(testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw testSeriesNotFound();
  }

  if (testSeries.type !== 'PDF') {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message,
    });
  }

  return testSeries;
}

// ─── Question Paper ──────────────────────────────────────────────────────────

export async function listActiveQuestionPaper(testSeriesId: string) {
  await requirePdfTestSeries(
    testSeriesId,
    'Question paper files are only applicable to PDF test series.',
  );

  return questionFileRepository.findActiveByTestSeriesId(testSeriesId);
}

export async function requestQuestionPaperUploadUrl(input: {
  testSeriesId: string;
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

  await requirePdfTestSeries(
    input.testSeriesId,
    'Question paper files are only applicable to PDF test series.',
  );

  const originalName = displayFileName(input.originalName);
  const fileId = new Types.ObjectId();
  const storageLocator = questionBlobLocator(fileId.toString());

  const file = await questionFileRepository.create({
    _id: fileId,
    testSeriesId: input.testSeriesId,
    questionId: null,
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

  getLogger({ module: 'files', event: 'QUESTION_PAPER_UPLOAD_AUTHORIZED' }).info(
    { fileId, testSeriesId: input.testSeriesId },
    'Question paper upload authorized',
  );

  return {
    file,
    uploadUrl: presigned.url,
    expiresAt: presigned.expiresAt,
  };
}

export async function completeQuestionPaperUpload(input: {
  testSeriesId: string;
  fileId: string;
  now?: Date;
}) {
  const testSeries = await testSeriesRepository.findById(input.testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw testSeriesNotFound();
  }

  const file = await questionFileRepository.findById(input.fileId);

  if (!file || file.deletedAt != null || file.testSeriesId.toString() !== input.testSeriesId) {
    throw questionPaperNotFound();
  }

  if (file.status === 'ACTIVE') {
    return file;
  }

  if (file.status !== 'PENDING') {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.FILE_ALREADY_FINALIZED,
      message: 'File has already been completed.',
    });
  }

  const { sizeBytes, mimeType } = await verifyUploadedObject(
    file.storageLocator,
    file._id.toString(),
  );

  const activated = await withTransaction(async (session) => {
    const fresh = await questionFileRepository.findById(file._id, { session });

    if (!fresh || fresh.deletedAt != null || fresh.testSeriesId.toString() !== input.testSeriesId) {
      throw questionPaperNotFound();
    }

    if (fresh.status === 'ACTIVE') {
      return fresh;
    }

    if (fresh.status !== 'PENDING') {
      throw new AppError({
        statusCode: 409,
        code: ErrorCodes.FILE_ALREADY_FINALIZED,
        message: 'File has already been completed.',
      });
    }

    await questionFileRepository.markReplacedExcept(input.testSeriesId, fresh._id, { session });

    return questionFileRepository.updateById(
      fresh._id,
      {
        $set: { status: 'ACTIVE', sizeBytes, mimeType },
      },
      { session },
    );
  });

  getLogger({ module: 'files', event: 'QUESTION_PAPER_ACTIVATED' }).info(
    { fileId: file._id.toString(), testSeriesId: input.testSeriesId },
    'Question paper activated',
  );

  return activated;
}

export async function getQuestionPaperDownloadUrl(input: {
  testSeriesId: string;
  fileId?: string;
  now?: Date;
}) {
  const testSeries = await testSeriesRepository.findById(input.testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw testSeriesNotFound();
  }

  let file;

  if (input.fileId) {
    file = await questionFileRepository.findById(input.fileId);

    if (!file || file.deletedAt != null || file.testSeriesId.toString() !== input.testSeriesId) {
      throw questionPaperNotFound();
    }
  } else {
    file = await questionFileRepository.findActiveByTestSeriesId(input.testSeriesId);

    if (!file) {
      throw questionPaperNotFound();
    }
  }

  if (file.status !== 'ACTIVE') {
    throw fileNotAccessible();
  }

  const presigned = await createPresignedDownloadUrl({
    locator: file.storageLocator,
    now: input.now,
  });

  return { downloadUrl: presigned.url };
}

// ─── Answer / Reference Files ─────────────────────────────────────────────────

export async function listActiveAnswerFiles(testSeriesId: string) {
  await requirePdfTestSeries(
    testSeriesId,
    'Answer files are only applicable to PDF test series.',
  );

  return answerFileRepository.findActiveByTestSeriesId(testSeriesId);
}

export async function requestAnswerFileUploadUrl(input: {
  testSeriesId: string;
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

  await requirePdfTestSeries(
    input.testSeriesId,
    'Answer files are only applicable to PDF test series.',
  );

  const originalName = displayFileName(input.originalName);
  const fileId = new Types.ObjectId();
  const storageLocator = answerBlobLocator(fileId.toString());

  const file = await answerFileRepository.create({
    _id: fileId,
    testSeriesId: input.testSeriesId,
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

  getLogger({ module: 'files', event: 'ANSWER_FILE_UPLOAD_AUTHORIZED' }).info(
    { fileId, testSeriesId: input.testSeriesId },
    'Answer file upload authorized',
  );

  return {
    file,
    uploadUrl: presigned.url,
    expiresAt: presigned.expiresAt,
  };
}

export async function completeAnswerFileUpload(input: {
  testSeriesId: string;
  fileId: string;
  now?: Date;
}) {
  const testSeries = await testSeriesRepository.findById(input.testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw testSeriesNotFound();
  }

  const file = await answerFileRepository.findById(input.fileId);

  if (!file || file.deletedAt != null || file.testSeriesId.toString() !== input.testSeriesId) {
    throw fileNotFound();
  }

  if (file.status === 'ACTIVE') {
    return file;
  }

  if (file.status !== 'PENDING') {
    throw new AppError({
      statusCode: 409,
      code: ErrorCodes.FILE_ALREADY_FINALIZED,
      message: 'File has already been completed.',
    });
  }

  const { sizeBytes, mimeType } = await verifyUploadedObject(
    file.storageLocator,
    file._id.toString(),
  );

  const activated = await answerFileRepository.updateById(file._id, {
    $set: { status: 'ACTIVE', sizeBytes, mimeType },
  });

  getLogger({ module: 'files', event: 'ANSWER_FILE_ACTIVATED' }).info(
    { fileId: file._id.toString(), testSeriesId: input.testSeriesId },
    'Answer file activated',
  );

  return activated;
}

export async function deleteAnswerFile(fileId: string) {
  const deleted = await answerFileRepository.markDeletedIfPendingOrActive(fileId, new Date());

  if (!deleted) {
    throw fileNotFound();
  }

  getLogger({ module: 'files', event: 'FILE_DELETED' }).info(
    { fileId: deleted._id.toString(), testSeriesId: deleted.testSeriesId.toString() },
    'Answer file logically deleted',
  );

  return deleted;
}

// ─── Authorized download for question/answer files ───────────────────────────

export async function createQuestionFileDownloadUrl(input: {
  fileId: string;
  testSeriesId?: string;
  now?: Date;
}) {
  const file = await questionFileRepository.findById(input.fileId);

  if (!file || file.deletedAt != null) {
    throw fileNotFound();
  }

  if (input.testSeriesId && file.testSeriesId.toString() !== input.testSeriesId) {
    throw fileNotAccessible();
  }

  if (file.status !== 'ACTIVE') {
    throw fileNotAccessible();
  }

  const fresh = await questionFileRepository.findById(input.fileId);

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
      'Failed to generate question file download URL',
    );

    throw new AppError({
      statusCode: 500,
      code: ErrorCodes.INTERNAL_SERVER_ERROR,
      message: 'Unable to generate download URL.',
    });
  }
}

export async function createAnswerFileDownloadUrl(input: {
  fileId: string;
  testSeriesId?: string;
  now?: Date;
}) {
  const file = await answerFileRepository.findById(input.fileId);

  if (!file || file.deletedAt != null) {
    throw fileNotFound();
  }

  if (input.testSeriesId && file.testSeriesId.toString() !== input.testSeriesId) {
    throw fileNotAccessible();
  }

  if (file.status !== 'ACTIVE') {
    throw fileNotAccessible();
  }

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
    if (error instanceof AppError) {
      throw error;
    }

    getLogger({ module: 'files', event: 'FILE_DOWNLOAD_FAILED' }).error(
      { fileId: input.fileId },
      'Failed to generate answer file download URL',
    );

    throw new AppError({
      statusCode: 500,
      code: ErrorCodes.INTERNAL_SERVER_ERROR,
      message: 'Unable to generate download URL.',
    });
  }
}
