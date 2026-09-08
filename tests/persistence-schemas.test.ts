import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  AnswerFileModel,
  AuthSessionModel,
  AttemptModel,
  AuditLogModel,
  CategoryModel,
  EntitlementModel,
  EvaluationModel,
  EvaluationRevisionModel,
  EvaluatorCategoryAssignmentModel,
  HttpIdempotencyKeyModel,
  ModuleModel,
  PasswordResetTokenModel,
  PurchaseModel,
  QuestionFileModel,
  QuestionModel,
  ResultModel,
  SubmissionFileModel,
  SubmissionModel,
  TestSeriesModel,
  UserModel,
  WebhookEventModel,
} from '../src/database/models/index';
import {
  ATTEMPT_STATUSES,
  CATALOG_STATUSES,
  COLLECTIONS,
  ENTITLEMENT_STATUSES,
  EVALUATION_MODES,
  EVALUATION_STATUSES,
  FILE_STATUSES,
  PURCHASE_STATUSES,
  TEST_SERIES_TYPES,
  USER_ROLES,
  USER_STATUSES,
} from '../src/database/models/enums';
import { PDF_SUBMISSION_MAX_SIZE_BYTES, V1_MAX_ATTEMPTS } from '../src/database/models/conventions';

const objectId = () => new Types.ObjectId();

describe('canonical collections', () => {
  it('registers the canonical collection names', () => {
    expect(UserModel.collection.collectionName).toBe(COLLECTIONS.users);
    expect(CategoryModel.collection.collectionName).toBe(COLLECTIONS.categories);
    expect(ModuleModel.collection.collectionName).toBe(COLLECTIONS.modules);
    expect(TestSeriesModel.collection.collectionName).toBe(COLLECTIONS.testSeries);
    expect(QuestionModel.collection.collectionName).toBe(COLLECTIONS.questions);
    expect(PurchaseModel.collection.collectionName).toBe(COLLECTIONS.purchases);
    expect(EntitlementModel.collection.collectionName).toBe(COLLECTIONS.entitlements);
    expect(AttemptModel.collection.collectionName).toBe(COLLECTIONS.attempts);
    expect(SubmissionModel.collection.collectionName).toBe(COLLECTIONS.submissions);
    expect(EvaluationModel.collection.collectionName).toBe(COLLECTIONS.evaluations);
    expect(EvaluationRevisionModel.collection.collectionName).toBe(COLLECTIONS.evaluationRevisions);
    expect(EvaluatorCategoryAssignmentModel.collection.collectionName).toBe(
      COLLECTIONS.evaluatorCategoryAssignments,
    );
    expect(ResultModel.collection.collectionName).toBe(COLLECTIONS.results);
    expect(QuestionFileModel.collection.collectionName).toBe(COLLECTIONS.questionFiles);
    expect(AnswerFileModel.collection.collectionName).toBe(COLLECTIONS.answerFiles);
    expect(SubmissionFileModel.collection.collectionName).toBe(COLLECTIONS.submissionFiles);
    expect(AuditLogModel.collection.collectionName).toBe(COLLECTIONS.auditLogs);
    expect(WebhookEventModel.collection.collectionName).toBe(COLLECTIONS.webhookEvents);
    expect(AuthSessionModel.collection.collectionName).toBe(COLLECTIONS.authSessions);
    expect(PasswordResetTokenModel.collection.collectionName).toBe(COLLECTIONS.passwordResetTokens);
    expect(HttpIdempotencyKeyModel.collection.collectionName).toBe(COLLECTIONS.httpIdempotencyKeys);
  });

  it('does not register speculative collections', () => {
    expect(mongoose.models.File).toBeUndefined();
    expect(mongoose.models.EvaluatorPaperAssignment).toBeUndefined();
    expect(Object.values(COLLECTIONS)).not.toContain('files');
    expect(Object.values(COLLECTIONS)).not.toContain('evaluatorPaperAssignments');
    expect(Object.values(COLLECTIONS)).not.toContain('payments');
    expect(Object.values(COLLECTIONS)).not.toContain('idempotencyRecords');
  });
});

describe('schema enums and statuses', () => {
  it('restricts user roles and statuses', async () => {
    expect(USER_ROLES).toEqual(['STUDENT', 'ADMIN', 'EVALUATOR']);
    expect(USER_STATUSES).toEqual(['ACTIVE', 'DISABLED']);
    expect(USER_STATUSES).not.toContain('DELETED');

    const invalidRole = new UserModel({
      email: 'student@example.com',
      passwordHash: 'hash',
      role: 'SUPERADMIN',
      name: { first: 'Ada', last: 'Lovelace' },
    });
    await expect(invalidRole.validate()).rejects.toThrow();

    const invalidStatus = new UserModel({
      email: 'student@example.com',
      passwordHash: 'hash',
      role: 'STUDENT',
      status: 'DELETED',
      name: { first: 'Ada', last: 'Lovelace' },
    });
    await expect(invalidStatus.validate()).rejects.toThrow();
  });

  it('restricts catalog statuses and test series types', async () => {
    expect(CATALOG_STATUSES).toEqual(['ACTIVE', 'INACTIVE', 'ARCHIVED']);
    expect(TEST_SERIES_TYPES).toEqual(['MCQ', 'PDF', 'EDITOR']);
    expect(TEST_SERIES_TYPES).not.toContain('WRITTEN');

    const invalidType = new TestSeriesModel({
      moduleId: objectId(),
      title: 'Mock',
      type: 'WRITTEN',
      duration: 3600,
      access: { isFree: true, price: 0, currency: 'INR' },
    });
    await expect(invalidType.validate()).rejects.toThrow();
  });

  it('restricts attempt, entitlement, and evaluation states', () => {
    expect(ATTEMPT_STATUSES).toEqual([
      'IN_PROGRESS',
      'UPLOAD_PENDING',
      'SUBMITTED',
      'EXPIRED',
      'CANCELLED',
    ]);
    expect(ENTITLEMENT_STATUSES).toEqual(['ACTIVE', 'EXPIRED', 'CONSUMED', 'REVOKED']);
    expect(EVALUATION_MODES).toEqual(['AUTOMATIC', 'MANUAL']);
    expect(EVALUATION_STATUSES).toEqual([
      'UNASSIGNED',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'FINALIZED',
    ]);
    expect(EVALUATION_STATUSES).not.toContain('REOPENED');
    expect(EVALUATION_STATUSES).not.toContain('ADMIN_REVIEW');
    expect(EVALUATION_STATUSES).not.toContain('ADMIN REVIEW');
    expect(FILE_STATUSES).toEqual(['PENDING', 'ACTIVE', 'REPLACED', 'DELETED']);
    expect(FILE_STATUSES).not.toContain('DRAFT');
    expect(FILE_STATUSES).not.toContain('SUBMITTED');
  });

  it('restricts purchase statuses to PENDING, PAID, and FAILED', async () => {
    expect(PURCHASE_STATUSES).toEqual(['PENDING', 'PAID', 'FAILED']);
    expect(PURCHASE_STATUSES).not.toContain('REFUNDED');
    expect(PURCHASE_STATUSES).not.toContain('CANCELLED');
    expect(PURCHASE_STATUSES).not.toContain('EXPIRED');
    expect(ENTITLEMENT_STATUSES).toEqual(['ACTIVE', 'EXPIRED', 'CONSUMED', 'REVOKED']);

    for (const status of PURCHASE_STATUSES) {
      const purchase = new PurchaseModel({
        studentId: objectId(),
        testSeriesId: objectId(),
        amount: 49900,
        currency: 'INR',
        status,
      });
      await purchase.validate();
    }

    const refunded = new PurchaseModel({
      studentId: objectId(),
      testSeriesId: objectId(),
      amount: 49900,
      currency: 'INR',
      status: 'REFUNDED' as string,
    });
    await expect(refunded.validate()).rejects.toThrow();
  });
});

describe('required references and canonical relationships', () => {
  it('requires Module.categoryId as the Category parent', async () => {
    expect(ModuleModel.schema.path('categoryId').options.ref).toBe('Category');
    const missing = new ModuleModel({ name: 'Algebra' });
    await expect(missing.validate()).rejects.toThrow();
  });

  it('requires Test Series.moduleId and does not use categoryId as parent', async () => {
    expect(TestSeriesModel.schema.path('moduleId').options.ref).toBe('Module');
    expect(TestSeriesModel.schema.path('categoryId')).toBeUndefined();

    const missing = new TestSeriesModel({
      title: 'Mock',
      type: 'MCQ',
      duration: 3600,
      access: { isFree: true, price: 0, currency: 'INR' },
    });
    await expect(missing.validate()).rejects.toThrow();
  });

  it('requires Question.testSeriesId', async () => {
    expect(QuestionModel.schema.path('testSeriesId').options.ref).toBe('TestSeries');
    const missing = new QuestionModel({ type: 'MCQ', position: 1 });
    await expect(missing.validate()).rejects.toThrow();
  });

  it('requires Entitlement student and test series refs, with nullable purchaseId', async () => {
    expect(EntitlementModel.schema.path('studentId').options.ref).toBe('User');
    expect(EntitlementModel.schema.path('testSeriesId').options.ref).toBe('TestSeries');
    expect(EntitlementModel.schema.path('purchaseId').options.ref).toBe('Purchase');

    const adminGranted = new EntitlementModel({
      studentId: objectId(),
      testSeriesId: objectId(),
      grantedAt: new Date(),
      expiresAt: new Date(),
    });
    await adminGranted.validate();
    expect(adminGranted.purchaseId).toBeNull();
  });

  it('requires Attempt student, test series, and entitlement refs', async () => {
    expect(AttemptModel.schema.path('studentId').options.ref).toBe('User');
    expect(AttemptModel.schema.path('testSeriesId').options.ref).toBe('TestSeries');
    expect(AttemptModel.schema.path('entitlementId').options.ref).toBe('Entitlement');

    const withoutEntitlement = new AttemptModel({
      studentId: objectId(),
      testSeriesId: objectId(),
      startedAt: new Date(),
      examEndsAt: new Date(),
      attemptNumber: 1,
      configurationSnapshot: { duration: 3600 },
    });
    await expect(withoutEntitlement.validate()).rejects.toThrow(/entitlementId/);
  });

  it('requires Submission.attemptId, Evaluation.submissionId, and Result.attemptId', () => {
    expect(SubmissionModel.schema.path('attemptId').options.ref).toBe('Attempt');
    expect(EvaluationModel.schema.path('submissionId').options.ref).toBe('Submission');
    expect(ResultModel.schema.path('attemptId').options.ref).toBe('Attempt');
  });

  it('requires evaluator category assignment refs', async () => {
    expect(EvaluatorCategoryAssignmentModel.schema.path('evaluatorId').options.ref).toBe('User');
    expect(EvaluatorCategoryAssignmentModel.schema.path('categoryId').options.ref).toBe('Category');
    const missing = new EvaluatorCategoryAssignmentModel({ evaluatorId: objectId() });
    await expect(missing.validate()).rejects.toThrow();
  });
});

describe('timestamps and soft deletion', () => {
  it('uses createdAt/updatedAt on historically tracked entities and deletedAt where required', () => {
    expect(UserModel.schema.path('createdAt')).toBeDefined();
    expect(UserModel.schema.path('updatedAt')).toBeDefined();
    expect(UserModel.schema.path('deletedAt')).toBeDefined();
    expect(CategoryModel.schema.path('deletedAt')).toBeDefined();
    expect(ModuleModel.schema.path('deletedAt')).toBeDefined();
    expect(TestSeriesModel.schema.path('deletedAt')).toBeDefined();
    expect(QuestionModel.schema.path('deletedAt')).toBeDefined();

    expect(AttemptModel.schema.path('createdAt')).toBeDefined();
    expect(AttemptModel.schema.path('updatedAt')).toBeDefined();
    expect(AttemptModel.schema.path('deletedAt')).toBeUndefined();
    expect(EntitlementModel.schema.path('deletedAt')).toBeUndefined();
    expect(PurchaseModel.schema.path('deletedAt')).toBeUndefined();
    expect(AuthSessionModel.schema.path('createdAt')).toBeDefined();
    expect(AuthSessionModel.schema.path('updatedAt')).toBeDefined();
    expect(AuthSessionModel.schema.path('expiresAt')).toBeDefined();
    expect(AuthSessionModel.schema.path('revokedAt')).toBeDefined();
    expect(AuthSessionModel.schema.path('refreshTokenHash')).toBeDefined();
    expect(PasswordResetTokenModel.schema.path('tokenHash')).toBeDefined();
    expect(PasswordResetTokenModel.schema.path('usedAt')).toBeDefined();
    expect(PasswordResetTokenModel.schema.path('expiresAt')).toBeDefined();
    expect(AuthSessionModel.schema.path('deletedAt')).toBeUndefined();
    expect(PasswordResetTokenModel.schema.path('deletedAt')).toBeUndefined();
    expect(SubmissionModel.schema.path('deletedAt')).toBeUndefined();
    expect(EvaluationModel.schema.path('deletedAt')).toBeUndefined();
    expect(ResultModel.schema.path('deletedAt')).toBeUndefined();
  });

  it('preserves domain-specific timestamps instead of substituting updatedAt', () => {
    expect(EntitlementModel.schema.path('grantedAt')).toBeDefined();
    expect(EntitlementModel.schema.path('expiresAt')).toBeDefined();
    expect(AttemptModel.schema.path('startedAt')).toBeDefined();
    expect(AttemptModel.schema.path('examEndsAt')).toBeDefined();
    expect(AttemptModel.schema.path('expiresAt')).toBeUndefined();
    expect(EvaluationModel.schema.path('assignedAt')).toBeDefined();
    expect(EvaluationModel.schema.path('startedAt')).toBeDefined();
    expect(EvaluationModel.schema.path('completedAt')).toBeDefined();
    expect(EvaluationModel.schema.path('finalizedAt')).toBeDefined();
    expect(EvaluationModel.schema.path('currentRevisionId')).toBeDefined();
  });
});

describe('Test Series configuration', () => {
  it('defaults free MCQ attempt policy to unlimited (null) and stores access, availability, and scoring', async () => {
    const testSeries = new TestSeriesModel({
      moduleId: objectId(),
      title: 'Mathematics Mock',
      type: 'MCQ',
      duration: 3600,
      access: { isFree: true, price: 0, currency: 'INR' },
      scoring: { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 },
    });

    await testSeries.validate();
    expect(testSeries.attemptPolicy.maxAttempts ?? null).toBeNull();
    expect(testSeries.scoring.maxScore).toBe(100);
    expect(testSeries.availability.startsAt).toBeNull();
    expect(testSeries.availability.endsAt).toBeNull();
  });

  it('accepts maxAttempts = null or 3 and rejects any other V1 attempt limit', async () => {
    const unlimited = new TestSeriesModel({
      moduleId: objectId(),
      title: 'Free MCQ Mock',
      type: 'MCQ',
      duration: 3600,
      access: { isFree: true, price: 0, currency: 'INR' },
      attemptPolicy: { maxAttempts: null },
    });
    await unlimited.validate();
    expect(unlimited.attemptPolicy.maxAttempts ?? null).toBeNull();

    const valid = new TestSeriesModel({
      moduleId: objectId(),
      title: 'Paid PDF Mock',
      type: 'PDF',
      duration: 3600,
      access: { isFree: false, price: 499, currency: 'INR' },
      attemptPolicy: { maxAttempts: V1_MAX_ATTEMPTS },
    });
    await valid.validate();
    expect(valid.attemptPolicy.maxAttempts).toBe(3);

    const invalid = new TestSeriesModel({
      moduleId: objectId(),
      title: 'Paid PDF Mock',
      type: 'PDF',
      duration: 3600,
      access: { isFree: false, price: 499, currency: 'INR' },
      attemptPolicy: { maxAttempts: 4 },
    });
    await expect(invalid.validate()).rejects.toThrow();
  });
});

describe('Entitlement persistence', () => {
  it('allows null expiresAt (free MCQ) and accepts paid expiresAt', async () => {
    const freeMcq = new EntitlementModel({
      studentId: objectId(),
      testSeriesId: objectId(),
      purchaseId: null,
      grantedAt: new Date(),
      expiresAt: null,
    });
    await freeMcq.validate();
    expect(freeMcq.expiresAt).toBeNull();

    const paid = new EntitlementModel({
      studentId: objectId(),
      testSeriesId: objectId(),
      purchaseId: objectId(),
      grantedAt: new Date(),
      expiresAt: new Date(),
    });
    await paid.validate();
    expect(paid.expiresAt).toBeInstanceOf(Date);
  });
});

describe('Attempt persistence', () => {
  it('requires examEndsAt and configurationSnapshot fields used for historical stability', async () => {
    const startedAt = new Date('2026-08-13T10:00:00.000Z');
    const examEndsAt = new Date('2026-08-13T11:00:00.000Z');
    const attempt = new AttemptModel({
      studentId: objectId(),
      testSeriesId: objectId(),
      entitlementId: objectId(),
      startedAt,
      examEndsAt,
      attemptNumber: 1,
      version: 1,
      configurationSnapshot: {
        duration: 3600,
        scoring: { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 },
        submissionGraceSeconds: 15,
        pdfUploadGraceSeconds: 300,
      },
      questionSnapshot: [
        {
          questionId: objectId(),
          order: 1,
          type: 'MCQ',
          question: { text: 'What is 2 + 2?' },
          marks: 4,
          evaluationData: { correctOptionId: 'B' },
        },
      ],
      answers: [
        {
          questionId: objectId(),
          selectedOptionIds: ['B'],
          updatedAt: startedAt,
        },
      ],
    });

    await attempt.validate();
    expect(attempt.status).toBe('IN_PROGRESS');
    expect(attempt.examEndsAt).toEqual(examEndsAt);
    expect(attempt.version).toBe(1);
    expect(attempt.configurationSnapshot.duration).toBe(3600);
    expect(attempt.configurationSnapshot.submissionGraceSeconds).toBe(15);
    expect(attempt.configurationSnapshot.pdfUploadGraceSeconds).toBe(300);
  });

  it('can persist EDITOR runtime content for resume without creating a new attempt document shape', async () => {
    const attempt = new AttemptModel({
      studentId: objectId(),
      testSeriesId: objectId(),
      entitlementId: objectId(),
      startedAt: new Date(),
      examEndsAt: new Date(),
      attemptNumber: 1,
      status: 'IN_PROGRESS',
      configurationSnapshot: { duration: 3600 },
      editorDocument: { type: 'doc', content: [{ type: 'paragraph', text: 'draft' }] },
    });

    await attempt.validate();
    expect(attempt.editorDocument).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', text: 'draft' }],
    });
  });

  it('rejects unsupported attempt states', async () => {
    const attempt = new AttemptModel({
      studentId: objectId(),
      testSeriesId: objectId(),
      startedAt: new Date(),
      examEndsAt: new Date(),
      attemptNumber: 1,
      status: 'AUTO_SUBMITTED',
      configurationSnapshot: { duration: 3600 },
    });
    await expect(attempt.validate()).rejects.toThrow();
  });
});

describe('Submission type-specific representation', () => {
  it('stores MCQ answers', async () => {
    const submission = new SubmissionModel({
      attemptId: objectId(),
      studentId: objectId(),
      type: 'MCQ',
      submittedAt: new Date(),
      answers: [{ questionId: objectId(), selectedOptionId: 'B' }],
    });
    await submission.validate();
    expect(submission.answers).toHaveLength(1);
    expect(submission.answers?.[0]?.selectedOptionId).toBe('B');
    expect(submission.editorDocument).toBeUndefined();
  });

  it('stores EDITOR editorDocument', async () => {
    const submission = new SubmissionModel({
      attemptId: objectId(),
      studentId: objectId(),
      type: 'EDITOR',
      submittedAt: new Date(),
      editorDocument: { type: 'doc', content: [] },
    });
    await submission.validate();
    expect(submission.editorDocument).toEqual({ type: 'doc', content: [] });
  });

  it('stores PDF answerSheetFile as a submissionFiles reference', async () => {
    expect(SubmissionModel.schema.path('answerSheetFile').options.ref).toBe('SubmissionFile');
    const fileId = objectId();
    const submission = new SubmissionModel({
      attemptId: objectId(),
      studentId: objectId(),
      type: 'PDF',
      submittedAt: new Date(),
      answerSheetFile: fileId,
    });
    await submission.validate();
    expect(submission.answerSheetFile?.toString()).toBe(fileId.toString());
    expect(SubmissionModel.schema.path('content')).toBeUndefined();
  });
});

describe('Evaluation persistence', () => {
  it('accepts persisted manual states and rejects REOPENED', async () => {
    const evaluation = new EvaluationModel({
      submissionId: objectId(),
      mode: 'MANUAL',
      status: 'UNASSIGNED',
    });
    await evaluation.validate();

    const reopened = new EvaluationModel({
      submissionId: objectId(),
      mode: 'MANUAL',
      status: 'REOPENED',
    });
    await expect(reopened.validate()).rejects.toThrow();
  });

  it('accepts AUTOMATIC mode for MCQ scoring records', async () => {
    const evaluation = new EvaluationModel({
      submissionId: objectId(),
      mode: 'AUTOMATIC',
      status: 'FINALIZED',
      score: 80,
      maxScore: 100,
    });
    await evaluation.validate();
  });

  it('stores immutable revisions under one logical Evaluation and rejects REOPENED', async () => {
    const evaluationId = objectId();
    const revision = new EvaluationRevisionModel({
      evaluationId,
      revisionNumber: 1,
      status: 'FINALIZED',
      score: 12.5,
    });
    await revision.validate();

    const reopened = new EvaluationRevisionModel({
      evaluationId,
      revisionNumber: 2,
      status: 'REOPENED',
    });
    await expect(reopened.validate()).rejects.toThrow();

    expect(EvaluationRevisionModel.schema.path('evaluationId').options.ref).toBe('Evaluation');
    expect(EvaluationModel.schema.path('currentRevisionId').options.ref).toBe('EvaluationRevision');
  });
});

describe('File metadata models', () => {
  it('stores provider-neutral Blob metadata for the three file domains without a generic files model', async () => {
    const shared = {
      storageProvider: 'VERCEL_BLOB',
      storageLocator: 'paper.pdf',
      originalName: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF_SUBMISSION_MAX_SIZE_BYTES,
      uploadedBy: objectId(),
    };

    const questionFile = new QuestionFileModel({ ...shared, testSeriesId: objectId() });
    const answerFile = new AnswerFileModel({
      ...shared,
      storageLocator: 'answer-key.pdf',
      testSeriesId: objectId(),
    });
    const submissionFile = new SubmissionFileModel({
      ...shared,
      storageLocator: 'submission-answer.pdf',
    });

    await questionFile.validate();
    await answerFile.validate();
    await submissionFile.validate();

    expect(submissionFile.submissionId).toBeNull();
    expect(submissionFile.status).toBe('PENDING');
    expect(PDF_SUBMISSION_MAX_SIZE_BYTES).toBe(20 * 1024 * 1024);
  });
});
