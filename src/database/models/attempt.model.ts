import { Schema, model, models } from 'mongoose';

import { optionalRef, requiredRef, timestampSchemaOptions } from './conventions';
import { ATTEMPT_STATUSES, COLLECTIONS, TEST_SERIES_TYPES } from './enums';

const scoringSnapshotSchema = new Schema(
  {
    correctMarks: { type: Number },
    incorrectMarks: { type: Number },
    unansweredMarks: { type: Number },
    maxScore: { type: Number },
  },
  { _id: false },
);

const configurationSnapshotSchema = new Schema(
  {
    duration: { type: Number, required: true },
    scoring: { type: scoringSnapshotSchema },
    submissionGraceSeconds: { type: Number, default: null },
    pdfUploadGraceSeconds: { type: Number, default: null },
  },
  { _id: false },
);

const questionSnapshotSchema = new Schema(
  {
    questionId: { type: Schema.Types.ObjectId, required: true },
    order: { type: Number, required: true },
    type: { type: String, required: true, enum: TEST_SERIES_TYPES },
    question: { type: Schema.Types.Mixed, required: true },
    marks: { type: Number },
    evaluationData: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const attemptAnswerSchema = new Schema(
  {
    questionId: { type: Schema.Types.ObjectId, required: true },
    selectedOptionIds: { type: [String], default: [] },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const attemptSchema = new Schema(
  {
    studentId: requiredRef('User'),
    testSeriesId: requiredRef('TestSeries'),
    entitlementId: requiredRef('Entitlement'),
    status: { type: String, required: true, enum: ATTEMPT_STATUSES, default: 'IN_PROGRESS' },
    startedAt: { type: Date, required: true },
    examEndsAt: { type: Date, required: true },
    uploadEndsAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    attemptNumber: { type: Number, required: true },
    version: { type: Number, required: true, default: 1 },
    lastSavedAt: { type: Date, default: null },
    currentSubmissionFileId: optionalRef('SubmissionFile'),
    questionPaperFileId: optionalRef('QuestionFile'),
    questionSnapshot: { type: [questionSnapshotSchema], default: [] },
    configurationSnapshot: { type: configurationSnapshotSchema, required: true },
    answers: { type: [attemptAnswerSchema], default: [] },
    editorDocument: { type: Schema.Types.Mixed, default: null },
    /** Exclusive exam overlay lock — one active client session at a time. */
    activeSessionId: { type: String, default: null },
    activeSessionExpiresAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.attempts },
);

attemptSchema.index({ entitlementId: 1, attemptNumber: 1 }, { unique: true });
attemptSchema.index({ examEndsAt: 1, status: 1 });
attemptSchema.index({ studentId: 1, status: 1 });
attemptSchema.index({ testSeriesId: 1 });
attemptSchema.index({ status: 1 });
attemptSchema.index({ studentId: 1, testSeriesId: 1, status: 1 });

export const AttemptModel = models.Attempt ?? model('Attempt', attemptSchema);
