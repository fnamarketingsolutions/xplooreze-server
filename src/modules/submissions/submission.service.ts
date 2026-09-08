import type { ClientSession } from 'mongoose';

import { PDF_SUBMISSION_MAX_SIZE_BYTES } from '../../database/models/conventions';
import type { UserStatus } from '../../database/models/enums';
import { remapDuplicateKey } from '../../database/errors';
import {
  attemptRepository,
  submissionFileRepository,
  submissionRepository,
} from '../../database/repositories/index';
import { withTransaction } from '../../database/transactions';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';
import { assertActiveOrContinuableAttempt } from '../attempts/attempt-access';
import {
  isPastExamEnd,
  isPdfDraftWindowOpen,
  isUploadWindowExpired,
  pdfUploadPendingFields,
  resolveAttemptType,
} from '../attempts/attempt-state';
import type { SubmitAttemptDto } from '../attempts/attempt.dto';
import {
  assertOrClaimExamSession,
  examSessionClearFields,
  examSessionConflict,
} from '../attempts/exam-session';
import {
  createPendingSubmissionFile,
  PDF_MIME_TYPE,
  toUploadAuthorizationDto,
  verifyUploadedSubmissionObject,
} from '../files/file.service';
import { toStudentSubmissionFileDto, type PdfUploadAuthorizationDto } from '../files/file.dto';
import { consumePaidEntitlementIfAttemptsExhausted } from '../entitlements/entitlement.service';
import { notifyAttemptSubmitted } from '../notifications/notification.service';
import type { RequestPdfUploadInput } from './submission.validation';

function attemptNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.ATTEMPT_NOT_FOUND,
    message: 'Attempt not found.',
  });
}

function attemptAlreadySubmitted(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.ATTEMPT_ALREADY_SUBMITTED,
    message: 'Attempt has already been submitted.',
  });
}

function attemptNotWritable(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.ATTEMPT_NOT_WRITABLE,
    message: 'Attempt is not writable.',
  });
}

function fileUploadNotAllowed(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.FILE_UPLOAD_NOT_ALLOWED,
    message: 'PDF upload is not allowed for this attempt.',
  });
}

function fileUploadExpired(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.FILE_UPLOAD_EXPIRED,
    message: 'PDF upload window has ended.',
  });
}

function fileUploadIncomplete(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.FILE_UPLOAD_INCOMPLETE,
    message: 'A verified PDF upload is required before submission.',
  });
}

function assertPdfDraftWindowOpen(
  attempt: { status: string; uploadEndsAt?: Date | null },
  now: Date,
): void {
  if (attempt.status === 'EXPIRED') {
    throw fileUploadExpired();
  }

  if (!isPdfDraftWindowOpen(attempt, now)) {
    throw attempt.status === 'UPLOAD_PENDING' ? fileUploadExpired() : fileUploadNotAllowed();
  }
}

function fileNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.FILE_NOT_FOUND,
    message: 'File not found.',
  });
}

function fileAlreadyFinalized(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.FILE_ALREADY_FINALIZED,
    message: 'File can no longer be changed.',
  });
}

async function loadOwnedAttempt(studentId: string, attemptId: string) {
  const attempt = await attemptRepository.findById(attemptId);

  if (!attempt || attempt.studentId.toString() !== studentId) {
    throw attemptNotFound();
  }

  return attempt;
}

async function expirePdfUploadWindowIfNeeded(
  attempt: Awaited<ReturnType<typeof attemptRepository.findById>>,
  now: Date,
) {
  if (!attempt || attempt.status !== 'UPLOAD_PENDING') {
    return attempt;
  }

  if (!isUploadWindowExpired(attempt, now)) {
    return attempt;
  }

  const expired = await attemptRepository.updateById(attempt._id, {
    $set: { status: 'EXPIRED', ...examSessionClearFields() },
  });
  await consumePaidEntitlementIfAttemptsExhausted(attempt.entitlementId.toString());
  return expired;
}

async function ensurePdfUploadPending(
  attempt: Awaited<ReturnType<typeof attemptRepository.findById>>,
  now: Date,
) {
  if (!attempt) {
    throw attemptNotFound();
  }

  if (attempt.status === 'SUBMITTED') {
    throw attemptAlreadySubmitted();
  }

  if (attempt.status === 'EXPIRED' || attempt.status === 'CANCELLED') {
    throw attempt.status === 'EXPIRED' ? fileUploadExpired() : attemptNotWritable();
  }

  if (attempt.status === 'IN_PROGRESS' && isPastExamEnd(attempt, now)) {
    const moved = await attemptRepository.updateById(attempt._id, {
      $set: pdfUploadPendingFields(attempt),
    });

    return expirePdfUploadWindowIfNeeded(moved ?? attempt, now);
  }

  if (attempt.status === 'UPLOAD_PENDING') {
    return expirePdfUploadWindowIfNeeded(attempt, now);
  }

  return attempt;
}

function submittedResponse(
  attemptId: string,
  submissionId: string,
  submittedAt: Date,
): SubmitAttemptDto {
  return {
    attemptId,
    submissionId,
    status: 'SUBMITTED',
    submittedAt: submittedAt.toISOString(),
  };
}

export async function finalizeMcqOrEditorAttempt(
  attempt: {
    _id: { toString(): string };
    studentId: { toString(): string };
    testSeriesId: { toString(): string };
    status: string;
    answers?: Array<{ questionId: unknown; selectedOptionIds?: string[] }>;
    editorDocument?: unknown;
    questionSnapshot?: Array<{ type: string }>;
  },
  submittedAt: Date,
  session?: ClientSession,
) {
  const type = await resolveAttemptType(attempt);
  const attemptId = attempt._id.toString();

  const existing = await submissionRepository.findByAttemptId(
    attemptId,
    session ? { session } : undefined,
  );

  if (existing) {
    const updated = await attemptRepository.updateById(
      attemptId,
      {
        $set: {
          status: 'SUBMITTED',
          submittedAt: existing.submittedAt,
          ...examSessionClearFields(),
        },
      },
      session ? { session } : undefined,
    );

    return {
      attempt: updated ?? attempt,
      submissionId: existing._id.toString(),
      submittedAt: existing.submittedAt,
      created: false as const,
    };
  }

  const submissionData: Record<string, unknown> = {
    attemptId,
    studentId: attempt.studentId.toString(),
    type,
    submittedAt,
  };

  if (type === 'MCQ') {
    submissionData.answers = (attempt.answers ?? []).map((answer) => ({
      questionId: answer.questionId,
      selectedOptionId: answer.selectedOptionIds?.[0] ?? null,
    }));
  } else if (type === 'EDITOR') {
    submissionData.editorDocument = attempt.editorDocument ?? null;
  }

  try {
    const submission = await submissionRepository.create(
      submissionData,
      session ? { session } : undefined,
    );

    const updated = await attemptRepository.updateById(
      attemptId,
      {
        $set: {
          status: 'SUBMITTED',
          submittedAt,
          ...examSessionClearFields(),
        },
      },
      session ? { session } : undefined,
    );

    return {
      attempt: updated ?? attempt,
      submissionId: submission._id.toString(),
      submittedAt,
      created: true as const,
    };
  } catch (error) {
    const raced = await submissionRepository.findByAttemptId(
      attemptId,
      session ? { session } : undefined,
    );

    if (raced) {
      return {
        attempt,
        submissionId: raced._id.toString(),
        submittedAt: raced.submittedAt,
        created: false as const,
      };
    }

    remapDuplicateKey(
      error,
      new AppError({
        statusCode: 409,
        code: ErrorCodes.ATTEMPT_ALREADY_SUBMITTED,
        message: 'Attempt has already been submitted.',
      }),
    );
  }
}

export async function requestPdfUploadUrl(
  studentId: string,
  attemptId: string,
  input: RequestPdfUploadInput,
  accountStatus: UserStatus = 'ACTIVE',
  now = new Date(),
  examSessionId?: string,
): Promise<PdfUploadAuthorizationDto> {
  if (!examSessionId) {
    throw examSessionConflict();
  }

  await assertOrClaimExamSession(studentId, attemptId, examSessionId, now);

  const attempt = await loadOwnedAttempt(studentId, attemptId);
  assertActiveOrContinuableAttempt(accountStatus, attempt.status);
  const attemptType = await resolveAttemptType(attempt);

  if (attemptType !== 'PDF') {
    throw fileUploadNotAllowed();
  }

  const ready = await ensurePdfUploadPending(attempt, now);

  if (!ready) {
    throw attemptNotFound();
  }

  if (ready.status === 'EXPIRED') {
    throw fileUploadExpired();
  }

  assertPdfDraftWindowOpen(ready, now);

  const pending = await createPendingSubmissionFile({
    attemptId,
    uploadedBy: studentId,
    originalName: input.originalName,
    mimeType: input.contentType,
    claimedSizeBytes: input.sizeBytes,
    now,
  });

  return toUploadAuthorizationDto(pending.file, pending.uploadUrl, pending.expiresAt);
}

export async function completePdfUpload(
  studentId: string,
  fileId: string,
  accountStatus: UserStatus = 'ACTIVE',
  now = new Date(),
) {
  const file = await submissionFileRepository.findById(fileId);

  if (!file || file.uploadedBy.toString() !== studentId || file.deletedAt != null) {
    throw fileNotFound();
  }

  if (!file.attemptId) {
    throw fileNotFound();
  }

  const attempt = await loadOwnedAttempt(studentId, file.attemptId.toString());
  assertActiveOrContinuableAttempt(accountStatus, attempt.status);
  const attemptType = await resolveAttemptType(attempt);

  if (attemptType !== 'PDF') {
    throw fileUploadNotAllowed();
  }

  const ready = await ensurePdfUploadPending(attempt, now);

  if (!ready) {
    throw attemptNotFound();
  }

  if (ready.status === 'SUBMITTED') {
    throw fileAlreadyFinalized();
  }

  if (ready.status === 'EXPIRED') {
    throw fileUploadExpired();
  }

  assertPdfDraftWindowOpen(ready, now);

  if (file.status === 'ACTIVE' && ready.currentSubmissionFileId?.toString() === fileId) {
    return toStudentSubmissionFileDto(file);
  }

  if (file.status !== 'PENDING') {
    throw fileAlreadyFinalized();
  }

  const verified = await verifyUploadedSubmissionObject(file);

  const activated = await withTransaction(async (session) => {
    const freshAttempt = await attemptRepository.findById(attempt._id, { session });

    if (!freshAttempt || freshAttempt.studentId.toString() !== studentId) {
      throw fileUploadNotAllowed();
    }

    assertPdfDraftWindowOpen(freshAttempt, now);

    const freshFile = await submissionFileRepository.findById(fileId, { session });

    if (!freshFile || freshFile.uploadedBy.toString() !== studentId) {
      throw fileNotFound();
    }

    if (freshFile.status === 'ACTIVE') {
      return freshFile;
    }

    if (freshFile.status !== 'PENDING') {
      throw fileAlreadyFinalized();
    }

    const updatedFile = await submissionFileRepository.updateById(
      fileId,
      {
        $set: {
          status: 'ACTIVE',
          sizeBytes: verified.sizeBytes,
          mimeType: verified.mimeType,
        },
      },
      { session },
    );

    await submissionFileRepository.markReplacedExcept(freshAttempt._id, fileId, { session });

    await attemptRepository.updateById(
      freshAttempt._id,
      {
        $set: { currentSubmissionFileId: fileId },
        $inc: { version: 1 },
      },
      { session },
    );

    return updatedFile ?? freshFile;
  });

  getLogger({ module: 'files', event: 'FILE_UPLOAD_COMPLETED' }).info(
    { fileId, attemptId: attempt._id.toString(), sizeBytes: verified.sizeBytes },
    'PDF upload confirmed',
  );

  return toStudentSubmissionFileDto(activated);
}

export async function finalizePdfAttempt(
  studentId: string,
  attemptId: string,
  now = new Date(),
): Promise<SubmitAttemptDto> {
  const attempt = await loadOwnedAttempt(studentId, attemptId);
  const attemptType = await resolveAttemptType(attempt);

  if (attemptType !== 'PDF') {
    throw attemptNotWritable();
  }

  if (attempt.status === 'SUBMITTED') {
    const existing = await submissionRepository.findByAttemptId(attemptId);
    await consumePaidEntitlementIfAttemptsExhausted(attempt.entitlementId.toString());
    return submittedResponse(
      attemptId,
      existing?._id.toString() ?? '',
      attempt.submittedAt ?? existing?.submittedAt ?? now,
    );
  }

  const ready = await ensurePdfUploadPending(attempt, now);

  if (!ready) {
    throw attemptNotFound();
  }

  if (ready.status === 'SUBMITTED') {
    const existing = await submissionRepository.findByAttemptId(attemptId);
    await consumePaidEntitlementIfAttemptsExhausted(ready.entitlementId.toString());
    return submittedResponse(
      attemptId,
      existing?._id.toString() ?? '',
      ready.submittedAt ?? existing?.submittedAt ?? now,
    );
  }

  if (ready.status === 'EXPIRED') {
    throw fileUploadExpired();
  }

  if (!isPdfDraftWindowOpen(ready, now)) {
    if (ready.status === 'UPLOAD_PENDING') {
      await expirePdfUploadWindowIfNeeded(ready, now);
      throw fileUploadExpired();
    }

    throw fileUploadNotAllowed();
  }

  const currentFileId = ready.currentSubmissionFileId?.toString();

  if (!currentFileId) {
    throw fileUploadIncomplete();
  }

  const currentFile = await submissionFileRepository.findById(currentFileId);

  if (
    !currentFile ||
    currentFile.status !== 'ACTIVE' ||
    currentFile.deletedAt != null ||
    currentFile.uploadedBy.toString() !== studentId ||
    currentFile.attemptId?.toString() !== attemptId ||
    currentFile.mimeType !== PDF_MIME_TYPE ||
    currentFile.sizeBytes > PDF_SUBMISSION_MAX_SIZE_BYTES ||
    currentFile.submissionId != null
  ) {
    throw fileUploadIncomplete();
  }

  try {
    const result = await withTransaction(async (session) => {
      const fresh = await attemptRepository.findById(attemptId, { session });

      if (!fresh || fresh.studentId.toString() !== studentId) {
        throw attemptNotFound();
      }

      if (fresh.status === 'SUBMITTED') {
        const existing = await submissionRepository.findByAttemptId(attemptId, { session });
        await consumePaidEntitlementIfAttemptsExhausted(fresh.entitlementId.toString(), session);
        return {
          dto: submittedResponse(
            attemptId,
            existing?._id.toString() ?? '',
            fresh.submittedAt ?? existing?.submittedAt ?? now,
          ),
          newlySubmitted: false as const,
        };
      }

      assertPdfDraftWindowOpen(fresh, now);

      const file = await submissionFileRepository.findById(currentFileId, { session });

      if (
        !file ||
        file.status !== 'ACTIVE' ||
        file.deletedAt != null ||
        file.uploadedBy.toString() !== studentId ||
        file.submissionId != null
      ) {
        throw fileUploadIncomplete();
      }

      const submission = await submissionRepository.create(
        {
          attemptId,
          studentId,
          type: 'PDF',
          submittedAt: now,
          answerSheetFile: currentFileId,
        },
        { session },
      );

      await submissionFileRepository.updateById(
        currentFileId,
        { $set: { submissionId: submission._id } },
        { session },
      );

      await attemptRepository.updateById(
        attemptId,
        {
          $set: {
            status: 'SUBMITTED',
            submittedAt: now,
            currentSubmissionFileId: currentFileId,
            ...examSessionClearFields(),
          },
        },
        { session },
      );
      await consumePaidEntitlementIfAttemptsExhausted(fresh.entitlementId.toString(), session);

      return {
        dto: submittedResponse(attemptId, submission._id.toString(), now),
        newlySubmitted: true as const,
        studentId,
        testSeriesId: fresh.testSeriesId.toString(),
        submittedAt: now,
      };
    });

    if (result.newlySubmitted) {
      await notifyAttemptSubmitted({
        studentId: result.studentId,
        testSeriesId: result.testSeriesId,
        attemptId,
        submittedAt: result.submittedAt,
      });
    }

    return result.dto;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    const existing = await submissionRepository.findByAttemptId(attemptId);

    if (existing) {
      return submittedResponse(attemptId, existing._id.toString(), existing.submittedAt);
    }

    remapDuplicateKey(error, attemptAlreadySubmitted());
  }
}
