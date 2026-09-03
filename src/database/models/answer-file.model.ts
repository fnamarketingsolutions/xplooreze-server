import { Schema, model, models } from 'mongoose';

import { createdAtOnlySchemaOptions, requiredRef } from './conventions';
import { COLLECTIONS, FILE_STATUSES, STORAGE_PROVIDERS } from './enums';

const answerFileSchema = new Schema(
  {
    testSeriesId: requiredRef('TestSeries'),
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
  { ...createdAtOnlySchemaOptions, collection: COLLECTIONS.answerFiles },
);

answerFileSchema.index({ testSeriesId: 1 });
answerFileSchema.index({ testSeriesId: 1, status: 1 });

export const AnswerFileModel = models.AnswerFile ?? model('AnswerFile', answerFileSchema);
