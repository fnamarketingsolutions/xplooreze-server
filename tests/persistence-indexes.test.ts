import { describe, expect, it } from 'vitest';

import { AnswerFileModel } from '../src/database/models/answer-file.model';
import { AttemptModel } from '../src/database/models/attempt.model';
import { AuditLogModel } from '../src/database/models/audit-log.model';
import { EntitlementModel } from '../src/database/models/entitlement.model';
import { EvaluationModel } from '../src/database/models/evaluation.model';
import { EvaluationRevisionModel } from '../src/database/models/evaluation-revision.model';
import { EvaluatorCategoryAssignmentModel } from '../src/database/models/evaluator-category-assignment.model';
import { HttpIdempotencyKeyModel } from '../src/database/models/http-idempotency-key.model';
import { ModuleModel } from '../src/database/models/module.model';
import { PasswordResetTokenModel } from '../src/database/models/password-reset-token.model';
import { PurchaseModel } from '../src/database/models/purchase.model';
import { QuestionFileModel } from '../src/database/models/question-file.model';
import { QuestionModel } from '../src/database/models/question.model';
import { ResultModel } from '../src/database/models/result.model';
import { SubmissionFileModel } from '../src/database/models/submission-file.model';
import { SubmissionModel } from '../src/database/models/submission.model';
import { TestSeriesModel } from '../src/database/models/test-series.model';
import { AuthSessionModel } from '../src/database/models/auth-session.model';
import {
  AUDIT_LOG_TTL_SECONDS,
  REVOKED_AUTH_SESSION_TTL_SECONDS,
  WEBHOOK_EVENT_TTL_SECONDS,
} from '../src/database/models/conventions';
import { UserModel } from '../src/database/models/user.model';
import { WebhookEventModel } from '../src/database/models/webhook-event.model';
import { findDeclaredIndex, hasDeclaredIndex } from './helpers/schema-indexes';

describe('declared indexes', () => {
  it('indexes catalog parent lookups', () => {
    expect(hasDeclaredIndex(ModuleModel.schema, { categoryId: 1 })).toBe(true);
    expect(hasDeclaredIndex(TestSeriesModel.schema, { moduleId: 1 })).toBe(true);
    expect(hasDeclaredIndex(QuestionModel.schema, { testSeriesId: 1 })).toBe(true);
  });

  it('declares a partial unique index for question position within a test series', () => {
    const positionIndex = findDeclaredIndex(QuestionModel.schema, {
      testSeriesId: 1,
      position: 1,
    });

    expect(positionIndex).toBeDefined();
    expect(positionIndex?.[1].unique).toBe(true);
    expect(positionIndex?.[1].partialFilterExpression).toEqual({ deletedAt: null });
  });

  it('declares a partial unique index for one ACTIVE entitlement per student and test series', () => {
    const activeEntitlementIndex = findDeclaredIndex(EntitlementModel.schema, {
      studentId: 1,
      testSeriesId: 1,
    });

    expect(activeEntitlementIndex).toBeDefined();
    expect(activeEntitlementIndex?.[1].unique).toBe(true);
    expect(activeEntitlementIndex?.[1].partialFilterExpression).toEqual({ status: 'ACTIVE' });
  });

  it('does not declare a global unique studentId + testSeriesId index on purchases', () => {
    const purchaseCompound = findDeclaredIndex(PurchaseModel.schema, {
      studentId: 1,
      testSeriesId: 1,
    });
    expect(purchaseCompound).toBeDefined();
    expect(purchaseCompound?.[1].unique).not.toBe(true);
  });

  it('declares partial unique Razorpay id indexes so multiple pending purchases can coexist', () => {
    const orderIndex = findDeclaredIndex(PurchaseModel.schema, { razorpayOrderId: 1 });
    const paymentIndex = findDeclaredIndex(PurchaseModel.schema, { razorpayPaymentId: 1 });

    expect(orderIndex?.[1].unique).toBe(true);
    expect(orderIndex?.[1].partialFilterExpression).toEqual({
      razorpayOrderId: { $type: 'string' },
    });
    expect(orderIndex?.[1].sparse).not.toBe(true);

    expect(paymentIndex?.[1].unique).toBe(true);
    expect(paymentIndex?.[1].partialFilterExpression).toEqual({
      razorpayPaymentId: { $type: 'string' },
    });
    expect(paymentIndex?.[1].sparse).not.toBe(true);
  });

  it('indexes attempts for resume, entitlement count, and exam deadline checks', () => {
    const attemptNumberIndex = findDeclaredIndex(AttemptModel.schema, {
      entitlementId: 1,
      attemptNumber: 1,
    });
    expect(attemptNumberIndex).toBeDefined();
    expect(attemptNumberIndex?.[1].unique).toBe(true);
    expect(
      findDeclaredIndex(AttemptModel.schema, {
        studentId: 1,
        testSeriesId: 1,
        attemptNumber: 1,
      }),
    ).toBeUndefined();
    expect(hasDeclaredIndex(AttemptModel.schema, { examEndsAt: 1, status: 1 })).toBe(true);
    expect(hasDeclaredIndex(AttemptModel.schema, { studentId: 1, status: 1 })).toBe(true);
  });

  it('declares uniqueness for one submission, evaluation, and result per owner', () => {
    const submissionAttempt = findDeclaredIndex(SubmissionModel.schema, { attemptId: 1 });
    const evaluationSubmission = findDeclaredIndex(EvaluationModel.schema, { submissionId: 1 });
    const resultAttempt = findDeclaredIndex(ResultModel.schema, { attemptId: 1 });

    expect(submissionAttempt?.[1].unique).toBe(true);
    expect(evaluationSubmission?.[1].unique).toBe(true);
    expect(resultAttempt?.[1].unique).toBe(true);

    const revisionNumber = findDeclaredIndex(EvaluationRevisionModel.schema, {
      evaluationId: 1,
      revisionNumber: 1,
    });
    expect(revisionNumber?.[1].unique).toBe(true);
    expect(hasDeclaredIndex(EvaluationRevisionModel.schema, { evaluationId: 1 })).toBe(true);
  });

  it('indexes file ownership and evaluator category assignment uniqueness', () => {
    expect(hasDeclaredIndex(QuestionFileModel.schema, { testSeriesId: 1 })).toBe(true);
    expect(hasDeclaredIndex(AnswerFileModel.schema, { testSeriesId: 1 })).toBe(true);
    expect(hasDeclaredIndex(SubmissionFileModel.schema, { submissionId: 1 })).toBe(true);
    expect(hasDeclaredIndex(SubmissionFileModel.schema, { attemptId: 1 })).toBe(true);

    const assignmentIndex = findDeclaredIndex(EvaluatorCategoryAssignmentModel.schema, {
      evaluatorId: 1,
      categoryId: 1,
    });
    expect(assignmentIndex?.[1].unique).toBe(true);
  });

  it('declares unique webhook provider + eventId, webhook createdAt TTL, and unique non-deleted user email', () => {
    const webhookIndex = findDeclaredIndex(WebhookEventModel.schema, {
      provider: 1,
      eventId: 1,
    });
    expect(webhookIndex?.[1].unique).toBe(true);

    const webhookTtl = findDeclaredIndex(WebhookEventModel.schema, { createdAt: 1 });
    expect(webhookTtl?.[1].expireAfterSeconds).toBe(WEBHOOK_EVENT_TTL_SECONDS);

    const emailIndex = findDeclaredIndex(UserModel.schema, { email: 1 });
    expect(emailIndex?.[1].unique).toBe(true);
    expect(emailIndex?.[1].partialFilterExpression).toEqual({ deletedAt: null });
  });

  it('indexes audit logs for actor/action/resource lookup and createdAt TTL', () => {
    expect(hasDeclaredIndex(AuditLogModel.schema, { actorUserId: 1 })).toBe(true);
    expect(hasDeclaredIndex(AuditLogModel.schema, { action: 1 })).toBe(true);
    expect(hasDeclaredIndex(AuditLogModel.schema, { 'resource.type': 1, 'resource.id': 1 })).toBe(
      true,
    );

    const auditTtl = findDeclaredIndex(AuditLogModel.schema, { createdAt: 1 });
    expect(auditTtl?.[1].expireAfterSeconds).toBe(AUDIT_LOG_TTL_SECONDS);
  });

  it('indexes authentication sessions for refresh-token lookup, family revocation, and revoked TTL', () => {
    const refreshHashIndex = findDeclaredIndex(AuthSessionModel.schema, { refreshTokenHash: 1 });
    expect(refreshHashIndex?.[1].unique).toBe(true);
    expect(hasDeclaredIndex(AuthSessionModel.schema, { userId: 1 })).toBe(true);
    expect(hasDeclaredIndex(AuthSessionModel.schema, { familyId: 1 })).toBe(true);
    expect(hasDeclaredIndex(AuthSessionModel.schema, { expiresAt: 1 })).toBe(true);

    const revokedTtl = findDeclaredIndex(AuthSessionModel.schema, { revokedAt: 1 });
    expect(revokedTtl?.[1].expireAfterSeconds).toBe(REVOKED_AUTH_SESSION_TTL_SECONDS);
  });

  it('indexes password reset tokens for hashed lookup and expiry cleanup', () => {
    const tokenHashIndex = findDeclaredIndex(PasswordResetTokenModel.schema, { tokenHash: 1 });
    expect(tokenHashIndex?.[1].unique).toBe(true);
    expect(hasDeclaredIndex(PasswordResetTokenModel.schema, { expiresAt: 1 })).toBe(true);
    expect(hasDeclaredIndex(PasswordResetTokenModel.schema, { userId: 1 })).toBe(true);
  });

  it('declares unique HTTP idempotency identity and TTL cleanup', () => {
    const identityIndex = findDeclaredIndex(HttpIdempotencyKeyModel.schema, {
      userId: 1,
      operation: 1,
      key: 1,
    });
    expect(identityIndex?.[1].unique).toBe(true);

    const ttlIndex = findDeclaredIndex(HttpIdempotencyKeyModel.schema, { expiresAt: 1 });
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex?.[1].expireAfterSeconds).toBe(0);
  });
});
