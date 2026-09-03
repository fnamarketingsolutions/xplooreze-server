import { describe, expect, it } from 'vitest';

import { PDF_SUBMISSION_MAX_SIZE_BYTES } from '../src/database/models/conventions';
import { submissionBlobLocator } from '../src/integrations/blob/blob.operations';
import { ErrorCodes } from '../src/shared/errors/app-error';
import {
  bufferStartsWithPdfMagic,
  PDF_MAGIC_BYTES,
} from '../src/integrations/blob/blob.operations';
import { displayFileName, isPdfMimeType } from '../src/modules/files/file.service';
import {
  parseCompleteUploadInput,
  parseRequestPdfUploadInput,
} from '../src/modules/submissions/submission.validation';

describe('Phase 9 unit rules', () => {
  it('builds opaque submission Blob locators from file ids', () => {
    const fileId = '64b7f2c8a1d2e3f4a5b6c7d8';
    expect(submissionBlobLocator(fileId)).toBe(`${fileId}.pdf`);
    expect(() => submissionBlobLocator('../etc/passwd')).toThrow(
      'Invalid file id for blob locator.',
    );
    expect(() => submissionBlobLocator('students/abc/attempts/def.pdf')).toThrow();
  });

  it('detects PDF magic bytes and application/pdf content type', () => {
    expect(PDF_MAGIC_BYTES.equals(Buffer.from('%PDF'))).toBe(true);
    expect(bufferStartsWithPdfMagic(Buffer.from('%PDF-1.4\n'))).toBe(true);
    expect(bufferStartsWithPdfMagic(Buffer.from('not-pdf'))).toBe(false);
    expect(isPdfMimeType('application/pdf')).toBe(true);
    expect(isPdfMimeType('APPLICATION/PDF')).toBe(true);
    expect(isPdfMimeType('application/octet-stream')).toBe(false);
    expect(isPdfMimeType('image/png')).toBe(false);
  });

  it('strips path components from original filenames', () => {
    expect(displayFileName('../../answer.pdf')).toBe('answer.pdf');
    expect(displayFileName('C:\\temp\\sheet.pdf')).toBe('sheet.pdf');
  });

  it('rejects oversized, non-PDF, unknown, and operator fields on upload authorization', () => {
    expect(() =>
      parseRequestPdfUploadInput({
        originalName: 'answer.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF_SUBMISSION_MAX_SIZE_BYTES + 1,
      }),
    ).toThrow();

    try {
      parseRequestPdfUploadInput({
        originalName: 'answer.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF_SUBMISSION_MAX_SIZE_BYTES + 1,
      });
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCodes.FILE_TOO_LARGE);
    }

    try {
      parseRequestPdfUploadInput({
        originalName: 'answer.png',
        contentType: 'image/png',
        sizeBytes: 100,
      });
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED);
    }

    expect(() =>
      parseRequestPdfUploadInput({
        originalName: 'answer.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
        storageLocator: 'other.pdf',
      }),
    ).toThrow();

    expect(() =>
      parseRequestPdfUploadInput({
        originalName: 'answer.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
        $set: { status: 'ACTIVE' },
      }),
    ).toThrow();

    expect(() => parseCompleteUploadInput({ storageLocator: 'injected.pdf' })).toThrow();
    expect(() => parseCompleteUploadInput({})).not.toThrow();
  });
});
