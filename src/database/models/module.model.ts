import { Schema, model, models } from 'mongoose';

import { requiredRef, timestampSchemaOptions } from './conventions';
import { CATALOG_STATUSES, COLLECTIONS } from './enums';

const moduleSchema = new Schema(
  {
    categoryId: requiredRef('Category'),
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    status: { type: String, required: true, enum: CATALOG_STATUSES, default: 'ACTIVE' },
    deletedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.modules },
);

moduleSchema.index({ categoryId: 1 });
moduleSchema.index({ status: 1 });
moduleSchema.index(
  { categoryId: 1, name: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE', deletedAt: null } },
);

export const ModuleModel = models.Module ?? model('Module', moduleSchema);
