import { Schema, model, models } from 'mongoose';

import { requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS } from './enums';

const evaluatorCategoryAssignmentSchema = new Schema(
  {
    evaluatorId: requiredRef('User'),
    categoryId: requiredRef('Category'),
    isActive: { type: Boolean, required: true, default: true },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.evaluatorCategoryAssignments },
);

evaluatorCategoryAssignmentSchema.index({ evaluatorId: 1, categoryId: 1 }, { unique: true });

export const EvaluatorCategoryAssignmentModel =
  models.EvaluatorCategoryAssignment ??
  model('EvaluatorCategoryAssignment', evaluatorCategoryAssignmentSchema);
