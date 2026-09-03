import { Schema, model, models } from 'mongoose';

import { requiredRef, timestampSchemaOptions, V1_MAX_ATTEMPTS } from './conventions';
import { CATALOG_STATUSES, COLLECTIONS, TEST_SERIES_TYPES } from './enums';

const testSeriesSchema = new Schema(
  {
    moduleId: requiredRef('Module'),
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: { type: String, required: true, enum: TEST_SERIES_TYPES },
    duration: { type: Number, required: true },
    access: {
      isFree: { type: Boolean, required: true },
      price: { type: Number, required: true, default: 0 },
      currency: { type: String, required: true, default: 'INR' },
    },
    availability: {
      startsAt: { type: Date, default: null },
      endsAt: { type: Date, default: null },
    },
    attemptPolicy: {
      maxAttempts: {
        type: Number,
        default: null,
        validate: {
          validator(value: number | null | undefined) {
            return value === null || value === undefined || value === V1_MAX_ATTEMPTS;
          },
          message: `V1 maxAttempts must be null (unlimited free MCQ) or ${V1_MAX_ATTEMPTS} (paid).`,
        },
      },
    },
    scoring: {
      correctMarks: { type: Number },
      incorrectMarks: { type: Number },
      unansweredMarks: { type: Number },
      maxScore: { type: Number, default: 100 },
    },
    status: { type: String, required: true, enum: CATALOG_STATUSES, default: 'ACTIVE' },
    deletedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.testSeries },
);

testSeriesSchema.index({ moduleId: 1 });
testSeriesSchema.index({ status: 1 });
testSeriesSchema.index({ type: 1 });

export const TestSeriesModel = models.TestSeries ?? model('TestSeries', testSeriesSchema);
