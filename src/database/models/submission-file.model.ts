import { Schema, model, models } from 'mongoose';

import { createdAtOnlySchemaOptions, optionalRef, requiredRef } from './conventions';
import { COLLECTIONS, FILE_STATUSES, STORAGE_PROVIDERS } from './enums';

const submissionFileSchema = new Schema(
  {
    submissionId: optionalRef('Submission'),
    attemptId: optionalRef('Attempt'),
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
  { ...createdAtOnlySchemaOptions, collection: COLLECTIONS.submissionFiles },
);

submissionFileSchema.index({ submissionId: 1 });
submissionFileSchema.index({ attemptId: 1 });
submissionFileSchema.index({ uploadedBy: 1 });

export const SubmissionFileModel =
  models.SubmissionFile ?? model('SubmissionFile', submissionFileSchema);
