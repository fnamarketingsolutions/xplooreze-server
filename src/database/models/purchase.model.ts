import { Schema, model, models } from 'mongoose';

import { requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS, PURCHASE_STATUSES } from './enums';

const purchaseReceiptSchema = new Schema(
  {
    number: { type: String, required: true },
    sequence: { type: Number, required: true },
    year: { type: Number, required: true },
    issuedAt: { type: Date, required: true },
    studentName: { type: String, required: true, default: '' },
    studentEmail: { type: String, required: true, default: '' },
    testSeriesTitle: { type: String, required: true, default: '' },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    razorpayPaymentId: { type: String, required: true, default: '' },
    sellerName: { type: String, required: true },
    sellerEmail: { type: String, required: true },
    sellerPhone: { type: String, required: true },
  },
  { _id: false },
);

const purchaseSchema = new Schema(
  {
    studentId: requiredRef('User'),
    testSeriesId: requiredRef('TestSeries'),
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'INR' },
    status: { type: String, required: true, enum: PURCHASE_STATUSES, default: 'PENDING' },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    receipt: { type: purchaseReceiptSchema, default: null },
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
purchaseSchema.index(
  { 'receipt.number': 1 },
  { unique: true, partialFilterExpression: { 'receipt.number': { $type: 'string' } } },
);
purchaseSchema.index(
  { 'receipt.year': 1, 'receipt.sequence': 1 },
  { unique: true, partialFilterExpression: { 'receipt.number': { $type: 'string' } } },
);

export const PurchaseModel = models.Purchase ?? model('Purchase', purchaseSchema);
