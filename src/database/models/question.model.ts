import { Schema, model, models } from 'mongoose';

import { requiredRef, timestampSchemaOptions } from './conventions';
import { CATALOG_STATUSES, COLLECTIONS, TEST_SERIES_TYPES } from './enums';

const questionSchema = new Schema(
  {
    testSeriesId: requiredRef('TestSeries'),
    type: { type: String, required: true, enum: TEST_SERIES_TYPES },
    position: { type: Number, required: true },
    questionText: { type: String, default: '' },
    content: { type: Schema.Types.Mixed, default: {} },
    marks: { type: Number },
    status: { type: String, required: true, enum: CATALOG_STATUSES, default: 'ACTIVE' },
    deletedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.questions, minimize: false },
);

questionSchema.index({ testSeriesId: 1 });
questionSchema.index(
  { testSeriesId: 1, position: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

export const QuestionModel = models.Question ?? model('Question', questionSchema);
