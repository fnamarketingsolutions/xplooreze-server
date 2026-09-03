import { Schema, model, models } from 'mongoose';

import { optionalRef, requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS, ENTITLEMENT_STATUSES } from './enums';

const entitlementSchema = new Schema(
  {
    studentId: requiredRef('User'),
    testSeriesId: requiredRef('TestSeries'),
    purchaseId: optionalRef('Purchase'),
    status: { type: String, required: true, enum: ENTITLEMENT_STATUSES, default: 'ACTIVE' },
    grantedAt: { type: Date, required: true },
    // Required for paid entitlements; null for free MCQ (enforced in EntitlementService).
    expiresAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.entitlements },
);

entitlementSchema.index({ studentId: 1 });
entitlementSchema.index({ testSeriesId: 1 });
entitlementSchema.index({ status: 1 });
entitlementSchema.index({ expiresAt: 1 });
entitlementSchema.index(
  { studentId: 1, testSeriesId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);

export const EntitlementModel = models.Entitlement ?? model('Entitlement', entitlementSchema);
