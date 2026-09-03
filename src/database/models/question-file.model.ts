import { Schema, model, models } from 'mongoose';

import { createdAtOnlySchemaOptions, optionalRef, requiredRef } from './conventions';
import { COLLECTIONS, FILE_STATUSES, STORAGE_PROVIDERS } from './enums';

const questionFileSchema = new Schema(
  {
    testSeriesId: requiredRef('TestSeries'),
    questionId: optionalRef('Question'),
    status: { type: String, required: true, enum: FILE_STATUSES, default: 'PENDING' },
    storageProvider: {
      type: String,
      required: true,
      enum: STORAGE_PROVIDERS,
      default: 'VERCEL_BLOB',
    },
    storageLocator: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    uploadedBy: requiredRef('User'),
    deletedAt: { type: Date, default: null },
  },
  { ...createdAtOnlySchemaOptions, collection: COLLECTIONS.questionFiles },
);

questionFileSchema.index({ testSeriesId: 1 });
questionFileSchema.index({ testSeriesId: 1, status: 1 });
questionFileSchema.index(
  { testSeriesId: 1, status: 1 },
  {
    name: 'unique_active_question_file_per_test_series',
    unique: true,
    partialFilterExpression: {
      status: 'ACTIVE',
      deletedAt: null,
    },
  },
);

export const QuestionFileModel = models.QuestionFile ?? model('QuestionFile', questionFileSchema);
