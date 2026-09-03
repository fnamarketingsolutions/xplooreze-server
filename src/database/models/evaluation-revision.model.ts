import { Schema, model, models } from 'mongoose';

import { optionalRef, requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS, EVALUATION_STATUSES } from './enums';

const scoringSnapshotSchema = new Schema(
  {
    correctMarks: { type: Number, required: true },
    incorrectMarks: { type: Number, required: true },
    unansweredMarks: { type: Number, required: true },
  },
  { _id: false },
);

const scoringMetricsSchema = new Schema(
  {
    correctCount: { type: Number, required: true },
    incorrectCount: { type: Number, required: true },
    unansweredCount: { type: Number, required: true },
  },
  { _id: false },
);

const evaluationRevisionSchema = new Schema(
  {
    evaluationId: requiredRef('Evaluation'),
    revisionNumber: { type: Number, required: true, min: 1 },
    status: { type: String, required: true, enum: EVALUATION_STATUSES },
    evaluatorId: optionalRef('User'),
    score: { type: Number, default: null },
    maxScore: { type: Number, default: null },
    remarks: { type: String, default: null },
    scoringSnapshot: { type: scoringSnapshotSchema, default: undefined },
    metrics: { type: scoringMetricsSchema, default: undefined },
    assignedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.evaluationRevisions },
);

evaluationRevisionSchema.index({ evaluationId: 1, revisionNumber: 1 }, { unique: true });
evaluationRevisionSchema.index({ evaluationId: 1 });
evaluationRevisionSchema.index({ evaluatorId: 1 });
evaluationRevisionSchema.index({ status: 1 });
evaluationRevisionSchema.index({ evaluatorId: 1, status: 1 });

export const EvaluationRevisionModel =
  models.EvaluationRevision ?? model('EvaluationRevision', evaluationRevisionSchema);
