import { Schema, model, models } from 'mongoose';

import { timestampSchemaOptions } from './conventions';
import { CATALOG_STATUSES, COLLECTIONS } from './enums';

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    status: { type: String, required: true, enum: CATALOG_STATUSES, default: 'ACTIVE' },
    deletedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.categories },
);

categorySchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE', deletedAt: null } },
);
categorySchema.index({ status: 1 });

export const CategoryModel = models.Category ?? model('Category', categorySchema);
