import { Schema, model, models } from 'mongoose';

import { optionalRef, requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS, EVALUATION_MODES, EVALUATION_STATUSES } from './enums';

const questionMarkSchema = new Schema(
  {
    questionId: { type: Schema.Types.ObjectId, required: true },
    marksAwarded: { type: Number, required: true },
    maxMarks: { type: Number, required: true },
  },
  { _id: false },
);

const evaluationSchema = new Schema(
  {
    submissionId: requiredRef('Submission'),
    mode: { type: String, required: true, enum: EVALUATION_MODES },
    status: { type: String, required: true, enum: EVALUATION_STATUSES },
    currentRevisionId: optionalRef('EvaluationRevision'),
    evaluatorId: optionalRef('User'),
    score: { type: Number, default: null },
    maxScore: { type: Number, default: null },
    remarks: { type: String, default: null },
    questionMarks: { type: [questionMarkSchema], default: [] },
    assignedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.evaluations },
);

evaluationSchema.index({ submissionId: 1 }, { unique: true });
evaluationSchema.index({ evaluatorId: 1 });
evaluationSchema.index({ status: 1 });
evaluationSchema.index({ mode: 1 });
evaluationSchema.index({ evaluatorId: 1, status: 1 });

export const EvaluationModel = models.Evaluation ?? model('Evaluation', evaluationSchema);
