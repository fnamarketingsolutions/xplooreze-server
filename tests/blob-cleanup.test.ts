import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, resetConfigForTests } from '../src/config/index';
import { AnswerFileModel } from '../src/database/models/answer-file.model';
import { AttemptModel } from '../src/database/models/attempt.model';
import { PENDING_FILE_ABANDONMENT_MS } from '../src/database/models/conventions';
import { QuestionFileModel } from '../src/database/models/question-file.model';
import { SubmissionFileModel } from '../src/database/models/submission-file.model';
import { setBlobStoreForTests } from '../src/integrations/blob/blob.operations';
import { runBlobCleanup } from '../src/modules/files/blob-cleanup.service';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import {
  createMemoryBlobStore,
  getMemoryBlob,
  putMemoryBlob,
  resetMemoryBlob,
} from './helpers/blob-memory';
import { clearMemoryMongo, startMemoryMongo, stopMemoryMongo } from './helpers/mongo-memory';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters-long';

function hoursAgo(hours: number, now: Date): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

describe('Blob cleanup', () => {
  beforeAll(async () => {
    await startMemoryMongo();
  });

  afterAll(async () => {
    await stopMemoryMongo();
  });

  beforeEach(() => {
    resetConfigForTests();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test';
    loadConfig();
    resetLoggerForTests();
    resetMemoryBlob();
    setBlobStoreForTests(createMemoryBlobStore());
  });

  afterEach(async () => {
    setBlobStoreForTests(null);
    resetMemoryBlob();
    await clearMemoryMongo();
    vi.restoreAllMocks();
  });

  it('deletes Blob for DELETED AnswerFiles without removing Mongo metadata', async () => {
    const fileId = new Types.ObjectId();
    const locator = `answers/${fileId.toString()}.pdf`;
    putMemoryBlob(locator, Buffer.from('%PDF-1.4\ndeleted\n%%EOF\n'), 'application/pdf');

    await AnswerFileModel.create({
      _id: fileId,
      testSeriesId: new Types.ObjectId(),
      status: 'DELETED',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: locator,
      originalName: 'answers.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 32,
      uploadedBy: new Types.ObjectId(),
      deletedAt: new Date(),
    });

    const summary = await runBlobCleanup();

    expect(summary.deletedBlobs).toBe(1);
    expect(getMemoryBlob(locator)).toBeUndefined();

    const after = await AnswerFileModel.findById(fileId);
    expect(after).toBeTruthy();
    expect(after!.status).toBe('DELETED');
    expect(after!.storageLocator).toBe(locator);
  });

  it('abandons PENDING older than 24h: marks DELETED then deletes Blob', async () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    const fileId = new Types.ObjectId();
    const locator = `questions/${fileId.toString()}.pdf`;
    putMemoryBlob(locator, Buffer.from('%PDF-1.4\nstale\n%%EOF\n'), 'application/pdf');

    await QuestionFileModel.create({
      _id: fileId,
      testSeriesId: new Types.ObjectId(),
      status: 'PENDING',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: locator,
      originalName: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 32,
      uploadedBy: new Types.ObjectId(),
    });
    await QuestionFileModel.collection.updateOne(
      { _id: fileId },
      { $set: { createdAt: hoursAgo(25, now) } },
    );

    const summary = await runBlobCleanup(now);

    expect(summary.abandonedPending).toBe(1);
    expect(summary.deletedBlobs).toBe(1);
    expect(getMemoryBlob(locator)).toBeUndefined();

    const after = await QuestionFileModel.findById(fileId);
    expect(after!.status).toBe('DELETED');
    expect(after!.deletedAt).toEqual(now);
  });

  it('does not abandon PENDING younger than 24 hours', async () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    const fileId = new Types.ObjectId();
    const locator = `answers/${fileId.toString()}.pdf`;
    putMemoryBlob(locator, Buffer.from('%PDF-1.4\nfresh\n%%EOF\n'), 'application/pdf');

    await AnswerFileModel.create({
      _id: fileId,
      testSeriesId: new Types.ObjectId(),
      status: 'PENDING',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: locator,
      originalName: 'answers.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 32,
      uploadedBy: new Types.ObjectId(),
    });
    await AnswerFileModel.collection.updateOne(
      { _id: fileId },
      { $set: { createdAt: hoursAgo(23, now) } },
    );

    const summary = await runBlobCleanup(now);

    expect(summary.abandonedPending).toBe(0);
    expect(getMemoryBlob(locator)).toBeTruthy();

    const after = await AnswerFileModel.findById(fileId);
    expect(after!.status).toBe('PENDING');
  });

  it('uses the locked 24-hour abandonment constant', () => {
    expect(PENDING_FILE_ABANDONMENT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('deletes REPLACED submission drafts after Attempt is SUBMITTED', async () => {
    const attemptId = new Types.ObjectId();
    const replacedId = new Types.ObjectId();
    const activeId = new Types.ObjectId();
    const replacedLocator = `${replacedId.toString()}.pdf`;
    const activeLocator = `${activeId.toString()}.pdf`;

    putMemoryBlob(replacedLocator, Buffer.from('%PDF-1.4\nold\n%%EOF\n'), 'application/pdf');
    putMemoryBlob(activeLocator, Buffer.from('%PDF-1.4\ncurrent\n%%EOF\n'), 'application/pdf');

    await AttemptModel.create({
      _id: attemptId,
      studentId: new Types.ObjectId(),
      testSeriesId: new Types.ObjectId(),
      entitlementId: new Types.ObjectId(),
      status: 'SUBMITTED',
      startedAt: new Date(),
      examEndsAt: new Date(),
      submittedAt: new Date(),
      attemptNumber: 1,
      currentSubmissionFileId: activeId,
      configurationSnapshot: { duration: 60 },
    });

    await SubmissionFileModel.create({
      _id: replacedId,
      attemptId,
      status: 'REPLACED',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: replacedLocator,
      originalName: 'draft-old.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 32,
      uploadedBy: new Types.ObjectId(),
    });

    await SubmissionFileModel.create({
      _id: activeId,
      attemptId,
      status: 'ACTIVE',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: activeLocator,
      originalName: 'draft-final.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 40,
      uploadedBy: new Types.ObjectId(),
    });

    const summary = await runBlobCleanup();

    expect(summary.deletedBlobs).toBe(1);
    expect(getMemoryBlob(replacedLocator)).toBeUndefined();
    expect(getMemoryBlob(activeLocator)).toBeTruthy();

    const replaced = await SubmissionFileModel.findById(replacedId);
    expect(replaced!.status).toBe('REPLACED');
  });

  it('leaves REPLACED submission drafts when Attempt is EXPIRED', async () => {
    const attemptId = new Types.ObjectId();
    const replacedId = new Types.ObjectId();
    const locator = `${replacedId.toString()}.pdf`;
    putMemoryBlob(locator, Buffer.from('%PDF-1.4\nexpired\n%%EOF\n'), 'application/pdf');

    await AttemptModel.create({
      _id: attemptId,
      studentId: new Types.ObjectId(),
      testSeriesId: new Types.ObjectId(),
      entitlementId: new Types.ObjectId(),
      status: 'EXPIRED',
      startedAt: new Date(),
      examEndsAt: new Date(),
      attemptNumber: 1,
      configurationSnapshot: { duration: 60 },
    });

    await SubmissionFileModel.create({
      _id: replacedId,
      attemptId,
      status: 'REPLACED',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: locator,
      originalName: 'draft.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 32,
      uploadedBy: new Types.ObjectId(),
    });

    const summary = await runBlobCleanup();

    expect(summary.deletedBlobs).toBe(0);
    expect(getMemoryBlob(locator)).toBeTruthy();
  });

  it('never deletes Blob for REPLACED question papers or ACTIVE files', async () => {
    const questionId = new Types.ObjectId();
    const answerId = new Types.ObjectId();
    const questionLocator = `questions/${questionId.toString()}.pdf`;
    const answerLocator = `answers/${answerId.toString()}.pdf`;

    putMemoryBlob(questionLocator, Buffer.from('%PDF-1.4\npaper\n%%EOF\n'), 'application/pdf');
    putMemoryBlob(answerLocator, Buffer.from('%PDF-1.4\nans\n%%EOF\n'), 'application/pdf');

    await QuestionFileModel.create({
      _id: questionId,
      testSeriesId: new Types.ObjectId(),
      status: 'REPLACED',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: questionLocator,
      originalName: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 32,
      uploadedBy: new Types.ObjectId(),
    });

    await AnswerFileModel.create({
      _id: answerId,
      testSeriesId: new Types.ObjectId(),
      status: 'ACTIVE',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: answerLocator,
      originalName: 'answers.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 32,
      uploadedBy: new Types.ObjectId(),
    });

    const summary = await runBlobCleanup();

    expect(summary.deletedBlobs).toBe(0);
    expect(getMemoryBlob(questionLocator)).toBeTruthy();
    expect(getMemoryBlob(answerLocator)).toBeTruthy();
  });

  it('does not delete Blob when PENDING was activated before abandon CAS', async () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    const fileId = new Types.ObjectId();
    const locator = `answers/${fileId.toString()}.pdf`;
    putMemoryBlob(locator, Buffer.from('%PDF-1.4\nrace\n%%EOF\n'), 'application/pdf');

    await AnswerFileModel.create({
      _id: fileId,
      testSeriesId: new Types.ObjectId(),
      status: 'PENDING',
      storageProvider: 'VERCEL_BLOB',
      storageLocator: locator,
      originalName: 'answers.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 32,
      uploadedBy: new Types.ObjectId(),
    });
    await AnswerFileModel.collection.updateOne(
      { _id: fileId },
      { $set: { createdAt: hoursAgo(25, now) } },
    );

    const { answerFileRepository } = await import('../src/database/repositories/files.repository');
    const pending = await answerFileRepository.findPendingCreatedBefore(
      new Date(now.getTime() - PENDING_FILE_ABANDONMENT_MS),
    );
    expect(pending).toHaveLength(1);

    await AnswerFileModel.findByIdAndUpdate(fileId, { $set: { status: 'ACTIVE' } });

    const abandoned = await answerFileRepository.markDeletedIfPending(fileId, now);
    expect(abandoned).toBeNull();

    const after = await AnswerFileModel.findById(fileId);
    expect(after!.status).toBe('ACTIVE');
    expect(getMemoryBlob(locator)).toBeTruthy();
  });
});
