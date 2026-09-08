export const USER_ROLES = ['STUDENT', 'ADMIN', 'EVALUATOR'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const CATALOG_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export const TEST_SERIES_TYPES = ['MCQ', 'PDF', 'EDITOR'] as const;
export type TestSeriesType = (typeof TEST_SERIES_TYPES)[number];

export const PURCHASE_STATUSES = ['PENDING', 'PAID', 'FAILED'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const ENTITLEMENT_STATUSES = ['ACTIVE', 'EXPIRED', 'CONSUMED', 'REVOKED'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  'IN_PROGRESS',
  'UPLOAD_PENDING',
  'SUBMITTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const EVALUATION_MODES = ['AUTOMATIC', 'MANUAL'] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];

export const EVALUATION_STATUSES = [
  'UNASSIGNED',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'FINALIZED',
] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export const RESULT_STATUSES = ['PENDING', 'PUBLISHED'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const STORAGE_PROVIDERS = ['VERCEL_BLOB'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const FILE_STATUSES = ['PENDING', 'ACTIVE', 'REPLACED', 'DELETED'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const WEBHOOK_PROVIDERS = ['RAZORPAY'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export const COLLECTIONS = {
  users: 'users',
  categories: 'categories',
  modules: 'modules',
  testSeries: 'testSeries',
  questions: 'questions',
  purchases: 'purchases',
  entitlements: 'entitlements',
  attempts: 'attempts',
  submissions: 'submissions',
  evaluations: 'evaluations',
  evaluationRevisions: 'evaluationRevisions',
  evaluatorCategoryAssignments: 'evaluatorCategoryAssignments',
  results: 'results',
  questionFiles: 'questionFiles',
  answerFiles: 'answerFiles',
  submissionFiles: 'submissionFiles',
  auditLogs: 'auditLogs',
  webhookEvents: 'webhookEvents',
  authSessions: 'authSessions',
  passwordResetTokens: 'passwordResetTokens',
  httpIdempotencyKeys: 'httpIdempotencyKeys',
  counters: 'counters',
} as const;
