import { Schema, model, models } from 'mongoose';

import { optionalRef, requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS, RESULT_STATUSES } from './enums';

const resultSchema = new Schema(
  {
    studentId: requiredRef('User'),
    testSeriesId: requiredRef('TestSeries'),
    attemptId: requiredRef('Attempt'),
    submissionId: requiredRef('Submission'),
    evaluationId: optionalRef('Evaluation'),
    score: { type: Number, required: true },
    maxScore: { type: Number, required: true },
    percentage: { type: Number, required: true },
    status: { type: String, required: true, enum: RESULT_STATUSES, default: 'PENDING' },
    publishedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.results },
);

resultSchema.index({ studentId: 1 });
resultSchema.index({ testSeriesId: 1 });
resultSchema.index({ attemptId: 1 }, { unique: true });
resultSchema.index({ status: 1 });
resultSchema.index({ studentId: 1, testSeriesId: 1 });

export const ResultModel = models.Result ?? model('Result', resultSchema);
