import { Schema, model, models } from 'mongoose';

import { requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS } from './enums';

export const HTTP_IDEMPOTENCY_RECORD_STATUSES = ['PROCESSING', 'COMPLETED'] as const;
export type HttpIdempotencyRecordStatus = (typeof HTTP_IDEMPOTENCY_RECORD_STATUSES)[number];

const httpIdempotencyKeySchema = new Schema(
  {
    userId: requiredRef('User'),
    operation: { type: String, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: HTTP_IDEMPOTENCY_RECORD_STATUSES,
      default: 'PROCESSING',
    },
    httpStatus: { type: Number, default: null },
    response: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.httpIdempotencyKeys },
);

httpIdempotencyKeySchema.index({ userId: 1, operation: 1, key: 1 }, { unique: true });
httpIdempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const HttpIdempotencyKeyModel =
  models.HttpIdempotencyKey ?? model('HttpIdempotencyKey', httpIdempotencyKeySchema);
