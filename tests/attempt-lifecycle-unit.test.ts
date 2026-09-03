import { describe, expect, it } from 'vitest';

import {
  EXAM_SUBMISSION_GRACE_SECONDS,
  PDF_UPLOAD_GRACE_SECONDS,
} from '../src/database/models/conventions';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { assertActiveOrContinuableAttempt } from '../src/modules/attempts/attempt-access';
import {
  canAcceptSubmitRequest,
  computeMcqEditorSubmissionDeadline,
  computePdfUploadEndsAt,
  isPastExamEnd,
  isPdfDraftWindowOpen,
  isUploadWindowExpired,
  pdfUploadPendingFields,
  shouldAutoFinalizeMcqEditor,
} from '../src/modules/attempts/attempt-state';
import {
  parseStartAttemptInput,
  parseUpdateAttemptAnswersInput,
} from '../src/modules/attempts/attempt.validation';

describe('Phase 20 attempt lifecycle unit rules', () => {
  it('computes uploadEndsAt as examEndsAt plus exactly 5 minutes', () => {
    expect(PDF_UPLOAD_GRACE_SECONDS).toBe(300);
    const examEndsAt = new Date('2026-08-18T11:00:00.000Z');
    const uploadEndsAt = computePdfUploadEndsAt(examEndsAt);
    expect(uploadEndsAt.toISOString()).toBe('2026-08-18T11:05:00.000Z');
    expect(uploadEndsAt.getTime() - examEndsAt.getTime()).toBe(5 * 60 * 1000);
  });

  it('does not overwrite an existing PDF uploadEndsAt during UPLOAD_PENDING transition', () => {
    const examEndsAt = new Date('2026-08-18T11:00:00.000Z');
    const existing = new Date('2026-08-18T11:05:00.000Z');
    const fields = pdfUploadPendingFields({ examEndsAt, uploadEndsAt: existing });
    expect(fields.status).toBe('UPLOAD_PENDING');
    expect(fields.uploadEndsAt).toBe(existing);
  });

  it('fills a missing PDF uploadEndsAt from examEndsAt plus 5 minutes', () => {
    const examEndsAt = new Date('2026-08-18T11:00:00.000Z');
    const fields = pdfUploadPendingFields({ examEndsAt, uploadEndsAt: null });
    expect(fields.uploadEndsAt.toISOString()).toBe('2026-08-18T11:05:00.000Z');
  });

  it('treats uploadEndsAt as expired only after the upload deadline', () => {
    const attempt = { uploadEndsAt: new Date('2026-08-18T11:05:00.000Z') };
    expect(isUploadWindowExpired(attempt, new Date('2026-08-18T11:05:00.000Z'))).toBe(false);
    expect(isUploadWindowExpired(attempt, new Date('2026-08-18T11:05:00.001Z'))).toBe(true);
    expect(
      isUploadWindowExpired({ uploadEndsAt: null }, new Date('2026-08-18T12:00:00.000Z')),
    ).toBe(false);
  });

  it('allows PDF draft upload and finalize during IN_PROGRESS through uploadEndsAt', () => {
    const uploadEndsAt = new Date('2026-08-18T11:05:00.000Z');
    const inProgress = { status: 'IN_PROGRESS' as const, uploadEndsAt };
    const pending = { status: 'UPLOAD_PENDING' as const, uploadEndsAt };

    expect(isPdfDraftWindowOpen(inProgress, new Date('2026-08-18T10:30:00.000Z'))).toBe(true);
    expect(isPdfDraftWindowOpen(inProgress, new Date('2026-08-18T11:05:00.000Z'))).toBe(true);
    expect(isPdfDraftWindowOpen(pending, new Date('2026-08-18T11:05:00.000Z'))).toBe(true);
    expect(isPdfDraftWindowOpen(inProgress, new Date('2026-08-18T11:05:00.001Z'))).toBe(false);
    expect(isPdfDraftWindowOpen({ status: 'SUBMITTED', uploadEndsAt }, uploadEndsAt)).toBe(
      false,
    );
  });

  it('keeps examEndsAt as the answering deadline', () => {
    const attempt = { examEndsAt: new Date('2026-08-18T11:00:00.000Z') };
    expect(isPastExamEnd(attempt, new Date('2026-08-18T10:59:59.999Z'))).toBe(false);
    expect(isPastExamEnd(attempt, new Date('2026-08-18T11:00:00.000Z'))).toBe(true);
  });

  it('accepts MCQ/EDITOR final submit through examEndsAt + 2 minutes and auto-finalizes after', () => {
    expect(EXAM_SUBMISSION_GRACE_SECONDS).toBe(120);
    const examEndsAt = new Date('2026-08-18T11:00:00.000Z');
    const attempt = { examEndsAt };
    const deadline = computeMcqEditorSubmissionDeadline(examEndsAt);
    expect(deadline.toISOString()).toBe('2026-08-18T11:02:00.000Z');

    expect(canAcceptSubmitRequest(attempt, new Date('2026-08-18T11:00:00.000Z'))).toBe(true);
    expect(canAcceptSubmitRequest(attempt, new Date('2026-08-18T11:01:59.999Z'))).toBe(true);
    expect(canAcceptSubmitRequest(attempt, new Date('2026-08-18T11:02:00.000Z'))).toBe(true);
    expect(canAcceptSubmitRequest(attempt, new Date('2026-08-18T11:02:00.001Z'))).toBe(false);

    expect(shouldAutoFinalizeMcqEditor(attempt, new Date('2026-08-18T11:02:00.000Z'))).toBe(false);
    expect(shouldAutoFinalizeMcqEditor(attempt, new Date('2026-08-18T11:02:00.001Z'))).toBe(true);
  });

  it('rejects client-supplied attempt timers and EDITOR execution fields', () => {
    expect(() =>
      parseStartAttemptInput({
        testSeriesId: '64b7f2c8a1d2e3f4a5b6c7d8',
        uploadEndsAt: '2099-01-01T00:00:00.000Z',
        examEndsAt: '2099-01-01T00:00:00.000Z',
      }),
    ).toThrow();

    const valid = parseUpdateAttemptAnswersInput({
      version: 1,
      editorDocument: { type: 'doc', content: [{ type: 'paragraph', text: 'answer' }] },
    });
    expect(valid.editorDocument).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', text: 'answer' }],
    });

    for (const field of [
      'code',
      'language',
      'testCases',
      'stdin',
      'stdout',
      'execution',
      'sandbox',
    ]) {
      expect(() =>
        parseUpdateAttemptAnswersInput({
          version: 1,
          editorDocument: { type: 'doc', [field]: true },
        }),
      ).toThrow();
    }
  });

  it('allows a disabled student to continue only IN_PROGRESS or UPLOAD_PENDING attempts', () => {
    expect(() => assertActiveOrContinuableAttempt('DISABLED', 'IN_PROGRESS')).not.toThrow();
    expect(() => assertActiveOrContinuableAttempt('DISABLED', 'UPLOAD_PENDING')).not.toThrow();
    expect(() => assertActiveOrContinuableAttempt('ACTIVE', 'SUBMITTED')).not.toThrow();

    for (const status of ['SUBMITTED', 'EXPIRED', 'CANCELLED']) {
      try {
        assertActiveOrContinuableAttempt('DISABLED', status);
        throw new Error(`expected ACCOUNT_DISABLED for ${status}`);
      } catch (error) {
        expect((error as { code: string }).code).toBe(ErrorCodes.ACCOUNT_DISABLED);
      }
    }
  });
});
