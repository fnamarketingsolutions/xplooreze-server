import { Schema, model, models } from 'mongoose';

import { requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS, PURCHASE_STATUSES } from './enums';

const purchaseSchema = new Schema(
  {
    studentId: requiredRef('User'),
    testSeriesId: requiredRef('TestSeries'),
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'INR' },
    status: { type: String, required: true, enum: PURCHASE_STATUSES, default: 'PENDING' },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.purchases },
);

purchaseSchema.index({ studentId: 1 });
purchaseSchema.index({ testSeriesId: 1 });
purchaseSchema.index({ studentId: 1, testSeriesId: 1 });
purchaseSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } },
);
purchaseSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } },
);
purchaseSchema.index({ status: 1 });

export const PurchaseModel = models.Purchase ?? model('Purchase', purchaseSchema);
