import { PDF_SUBMISSION_MAX_SIZE_BYTES } from '../../database/models/conventions';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import {
  asRecord,
  readNumber,
  readRouteParam,
  readString,
  rejectUnknownFields,
  validationError,
} from '../../shared/validation/http';
import { isPdfMimeType } from '../files/file.service';

const UPLOAD_FIELDS = ['originalName', 'contentType', 'sizeBytes'] as const;

export type RequestPdfUploadInput = {
  originalName: string;
  contentType: string;
  sizeBytes: number;
};

export function parseFileId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'fileId');
}

export function parseRequestPdfUploadInput(body: unknown): RequestPdfUploadInput {
  const record = asRecord(body);
  rejectUnknownFields(record, UPLOAD_FIELDS);

  if (record.originalName === undefined) {
    throw validationError({ originalName: 'Required.' });
  }

  if (record.contentType === undefined) {
    throw validationError({ contentType: 'Required.' });
  }

  if (record.sizeBytes === undefined) {
    throw validationError({ sizeBytes: 'Required.' });
  }

  const originalName = readString(record.originalName, 'originalName').trim();

  if (originalName.length === 0) {
    throw validationError({ originalName: 'Must not be empty.' });
  }

  if (originalName.length > 255) {
    throw validationError({ originalName: 'Must be at most 255 characters.' });
  }

  const contentType = readString(record.contentType, 'contentType').trim();

  if (!isPdfMimeType(contentType)) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
      message: 'PDF submission files must be application/pdf.',
    });
  }

  const sizeBytes = readNumber(record.sizeBytes, 'sizeBytes');

  if (!Number.isInteger(sizeBytes) || sizeBytes < 1) {
    throw validationError({ sizeBytes: 'Must be a positive integer.' });
  }

  if (sizeBytes > PDF_SUBMISSION_MAX_SIZE_BYTES) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.FILE_TOO_LARGE,
      message: 'PDF submission files must be 20 MB or smaller.',
    });
  }

  return {
    originalName,
    contentType,
    sizeBytes,
  };
}

export function parseCompleteUploadInput(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }

  const record = asRecord(body);
  rejectUnknownFields(record, []);
}
