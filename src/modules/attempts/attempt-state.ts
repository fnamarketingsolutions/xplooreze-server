import {
  EXAM_SUBMISSION_GRACE_SECONDS,
  PDF_UPLOAD_GRACE_SECONDS,
} from '../../database/models/conventions';
import { testSeriesRepository } from '../../database/repositories/index';

export function isPastExamEnd(attempt: { examEndsAt: Date }, now: Date): boolean {
  return now.getTime() >= attempt.examEndsAt.getTime();
}

export function computePdfUploadEndsAt(examEndsAt: Date): Date {
  return new Date(examEndsAt.getTime() + PDF_UPLOAD_GRACE_SECONDS * 1000);
}

export function computeMcqEditorSubmissionDeadline(examEndsAt: Date): Date {
  return new Date(examEndsAt.getTime() + EXAM_SUBMISSION_GRACE_SECONDS * 1000);
}

export function pdfUploadPendingFields(attempt: { examEndsAt: Date; uploadEndsAt?: Date | null }): {
  status: 'UPLOAD_PENDING';
  uploadEndsAt: Date;
} {
  return {
    status: 'UPLOAD_PENDING',
    uploadEndsAt: attempt.uploadEndsAt ?? computePdfUploadEndsAt(attempt.examEndsAt),
  };
}

export function isUploadWindowExpired(attempt: { uploadEndsAt?: Date | null }, now: Date): boolean {
  if (attempt.uploadEndsAt == null) {
    return false;
  }

  return now.getTime() > attempt.uploadEndsAt.getTime();
}

/** PDF draft upload and finalize: IN_PROGRESS or UPLOAD_PENDING, through uploadEndsAt. */
export function isPdfDraftWindowOpen(
  attempt: { status: string; uploadEndsAt?: Date | null },
  now: Date,
): boolean {
  if (attempt.status !== 'IN_PROGRESS' && attempt.status !== 'UPLOAD_PENDING') {
    return false;
  }

  return !isUploadWindowExpired(attempt, now);
}

export function canAcceptSubmitRequest(attempt: { examEndsAt: Date }, now: Date): boolean {
  return now.getTime() <= computeMcqEditorSubmissionDeadline(attempt.examEndsAt).getTime();
}

export function shouldAutoFinalizeMcqEditor(attempt: { examEndsAt: Date }, now: Date): boolean {
  return now.getTime() > computeMcqEditorSubmissionDeadline(attempt.examEndsAt).getTime();
}

export async function resolveAttemptType(attempt: {
  testSeriesId: { toString(): string };
  questionSnapshot?: Array<{ type: string }>;
  editorDocument?: unknown;
}): Promise<'MCQ' | 'PDF' | 'EDITOR'> {
  const fromSnapshot = attempt.questionSnapshot?.[0]?.type;

  if (fromSnapshot === 'MCQ' || fromSnapshot === 'PDF' || fromSnapshot === 'EDITOR') {
    return fromSnapshot;
  }

  if (attempt.editorDocument != null) {
    return 'EDITOR';
  }

  const testSeries = await testSeriesRepository.findById(attempt.testSeriesId.toString());

  if (testSeries?.type === 'MCQ' || testSeries?.type === 'PDF' || testSeries?.type === 'EDITOR') {
    return testSeries.type;
  }

  return 'MCQ';
}
