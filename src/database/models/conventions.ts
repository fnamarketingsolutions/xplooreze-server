import { Schema } from 'mongoose';

/** Paid PDF/EDITOR entitlement attempt cap. Free MCQ is unlimited (no cap). */
export const V1_MAX_ATTEMPTS = 3;

/** Free MCQ path: unlimited attempts. Paid PDF/EDITOR: capped at V1_MAX_ATTEMPTS. */
export function isUnlimitedAttemptPath(testSeries: {
  type: string;
  access?: { isFree?: boolean };
}): boolean {
  return testSeries.type === 'MCQ' || testSeries.access?.isFree === true;
}

/**
 * Catalog / API maxAttempts. Returns null for unlimited free MCQ even when a
 * legacy row still stores 3.
 */
export function resolveMaxAttempts(testSeries: {
  type: string;
  access?: { isFree?: boolean };
  attemptPolicy?: { maxAttempts?: number | null };
}): number | null {
  if (isUnlimitedAttemptPath(testSeries)) {
    return null;
  }
  return testSeries.attemptPolicy?.maxAttempts ?? V1_MAX_ATTEMPTS;
}
export const PAID_ENTITLEMENT_VALIDITY_DAYS = 60;
export const PDF_SUBMISSION_MAX_SIZE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_SCORE = 100;
/** Locked V1 PDF upload grace. MCQ/EDITOR do not receive this window. */
export const PDF_UPLOAD_GRACE_SECONDS = 5 * 60;
/** Locked V1 MCQ/EDITOR server-only final-submit window after examEndsAt. */
export const EXAM_SUBMISSION_GRACE_SECONDS = 2 * 60;
/** Locked V1 PENDING Purchase reuse window. */
export const PENDING_PURCHASE_REUSE_WINDOW_MS = 30 * 60 * 1000;
/** Locked V1: PENDING purchases older than this are marked FAILED by the purchase cleanup job. */
export const STALE_PENDING_PURCHASE_MS = 7 * 24 * 60 * 60 * 1000;
/** Implementation TTL for HTTP idempotency records. Architecture leaves store TTL TBD. */
export const HTTP_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Locked V1: PENDING file metadata older than this is abandoned by Blob cleanup cron. */
export const PENDING_FILE_ABANDONMENT_MS = 24 * 60 * 60 * 1000;
/** Locked V1: Mongo TTL on webhookEvents.createdAt (Razorpay retries ~24h; 7d margin). */
export const WEBHOOK_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Locked V1: Mongo TTL on auditLogs.createdAt. */
export const AUDIT_LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * Locked V1: Mongo TTL on authSessions.revokedAt. A revoked/rotated session is
 * retained only as the reuse-detection tripwire, so it does not need the full
 * refresh lifetime. Active sessions have `revokedAt: null` and are ignored by TTL.
 */
export const REVOKED_AUTH_SESSION_TTL_SECONDS = 24 * 60 * 60;
/**
 * Locked V1: how long an exam overlay session lock stays exclusive without a
 * heartbeat/claim refresh. Client heartbeats ~every 25s.
 */
export const EXAM_SESSION_LOCK_TTL_MS = 60 * 1000;

export const timestampSchemaOptions = {
  timestamps: true,
  versionKey: false,
} as const;

export const createdAtOnlySchemaOptions = {
  timestamps: { createdAt: true, updatedAt: false },
  versionKey: false,
} as const;

export function requiredRef(modelName: string) {
  return { type: Schema.Types.ObjectId, ref: modelName, required: true as const };
}

export function optionalRef(modelName: string) {
  return { type: Schema.Types.ObjectId, ref: modelName, default: null };
}
