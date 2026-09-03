import { PENDING_FILE_ABANDONMENT_MS } from '../../database/models/conventions';
import {
  answerFileRepository,
  questionFileRepository,
  submissionFileRepository,
} from '../../database/repositories/index';
import { deleteBlob } from '../../integrations/blob/index';
import { getLogger } from '../../shared/logger/logger';

export type BlobCleanupSummary = {
  abandonedPending: number;
  deletedBlobs: number;
  failedBlobDeletes: number;
};

type CleanupCandidate = {
  domain: 'questionFiles' | 'answerFiles' | 'submissionFiles';
  fileId: string;
  storageLocator: string;
  reason: 'DELETED' | 'ABANDONED_PENDING' | 'REPLACED_AFTER_SUBMIT';
};

async function safeDeleteBlob(locator: string, context: CleanupCandidate): Promise<boolean> {
  try {
    await deleteBlob(locator);
    getLogger({ module: 'files', event: 'BLOB_CLEANUP_DELETED' }).info(
      {
        domain: context.domain,
        fileId: context.fileId,
        reason: context.reason,
      },
      'Blob object deleted by cleanup',
    );
    return true;
  } catch (error) {
    getLogger({ module: 'files', event: 'BLOB_CLEANUP_DELETE_FAILED' }).error(
      {
        domain: context.domain,
        fileId: context.fileId,
        reason: context.reason,
        err: error,
      },
      'Failed to delete Blob object during cleanup',
    );
    return false;
  }
}

async function abandonPendingFiles(now: Date): Promise<CleanupCandidate[]> {
  const cutoff = new Date(now.getTime() - PENDING_FILE_ABANDONMENT_MS);
  const deletedAt = now;
  const candidates: CleanupCandidate[] = [];

  const pendingQuestions = await questionFileRepository.findPendingCreatedBefore(cutoff);
  for (const file of pendingQuestions) {
    const abandoned = await questionFileRepository.markDeletedIfPending(file._id, deletedAt);
    if (!abandoned) {
      continue;
    }
    candidates.push({
      domain: 'questionFiles',
      fileId: abandoned._id.toString(),
      storageLocator: abandoned.storageLocator,
      reason: 'ABANDONED_PENDING',
    });
  }

  const pendingAnswers = await answerFileRepository.findPendingCreatedBefore(cutoff);
  for (const file of pendingAnswers) {
    const abandoned = await answerFileRepository.markDeletedIfPending(file._id, deletedAt);
    if (!abandoned) {
      continue;
    }
    candidates.push({
      domain: 'answerFiles',
      fileId: abandoned._id.toString(),
      storageLocator: abandoned.storageLocator,
      reason: 'ABANDONED_PENDING',
    });
  }

  const pendingSubmissions = await submissionFileRepository.findPendingCreatedBefore(cutoff);
  for (const file of pendingSubmissions) {
    const abandoned = await submissionFileRepository.markDeletedIfPending(file._id, deletedAt);
    if (!abandoned) {
      continue;
    }
    candidates.push({
      domain: 'submissionFiles',
      fileId: abandoned._id.toString(),
      storageLocator: abandoned.storageLocator,
      reason: 'ABANDONED_PENDING',
    });
  }

  return candidates;
}

async function collectDeletedFileCandidates(): Promise<CleanupCandidate[]> {
  const candidates: CleanupCandidate[] = [];

  const deletedQuestions = await questionFileRepository.findByStatus('DELETED');
  for (const file of deletedQuestions) {
    candidates.push({
      domain: 'questionFiles',
      fileId: file._id.toString(),
      storageLocator: file.storageLocator,
      reason: 'DELETED',
    });
  }

  const deletedAnswers = await answerFileRepository.findByStatus('DELETED');
  for (const file of deletedAnswers) {
    candidates.push({
      domain: 'answerFiles',
      fileId: file._id.toString(),
      storageLocator: file.storageLocator,
      reason: 'DELETED',
    });
  }

  const deletedSubmissions = await submissionFileRepository.findByStatus('DELETED');
  for (const file of deletedSubmissions) {
    candidates.push({
      domain: 'submissionFiles',
      fileId: file._id.toString(),
      storageLocator: file.storageLocator,
      reason: 'DELETED',
    });
  }

  return candidates;
}

async function collectReplacedSubmittedDrafts(): Promise<CleanupCandidate[]> {
  const files = await submissionFileRepository.findReplacedForSubmittedAttempts();
  return files.map((file) => ({
    domain: 'submissionFiles' as const,
    fileId: file._id.toString(),
    storageLocator: file.storageLocator,
    reason: 'REPLACED_AFTER_SUBMIT' as const,
  }));
}

/**
 * Cron-owned Blob physical cleanup. Never called from HTTP product paths.
 * Mongo status transitions happen before Blob delete.
 */
export async function runBlobCleanup(now: Date = new Date()): Promise<BlobCleanupSummary> {
  const abandoned = await abandonPendingFiles(now);
  const deleted = await collectDeletedFileCandidates();
  const replacedAfterSubmit = await collectReplacedSubmittedDrafts();

  const byLocator = new Map<string, CleanupCandidate>();
  for (const candidate of [...abandoned, ...deleted, ...replacedAfterSubmit]) {
    byLocator.set(candidate.storageLocator, candidate);
  }

  let deletedBlobs = 0;
  let failedBlobDeletes = 0;

  for (const candidate of byLocator.values()) {
    const ok = await safeDeleteBlob(candidate.storageLocator, candidate);
    if (ok) {
      deletedBlobs += 1;
    } else {
      failedBlobDeletes += 1;
    }
  }

  const summary: BlobCleanupSummary = {
    abandonedPending: abandoned.length,
    deletedBlobs,
    failedBlobDeletes,
  };

  getLogger({ module: 'files', event: 'BLOB_CLEANUP_COMPLETED' }).info(
    summary,
    'Blob cleanup run completed',
  );

  return summary;
}
