import { Schema, model, models } from 'mongoose';

import { COLLECTIONS } from './enums';

const counterSchema = new Schema(
  {
    key: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: COLLECTIONS.counters },
);

counterSchema.index({ key: 1 }, { unique: true });

export const CounterModel = models.Counter ?? model('Counter', counterSchema);
