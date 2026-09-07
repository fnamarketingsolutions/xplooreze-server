import type { Types } from 'mongoose';

import { EntitlementModel } from '../models/entitlement.model';
import { PurchaseModel } from '../models/purchase.model';
import {
  countDocuments,
  createDocument,
  findById,
  listDocuments,
  updateById,
  withSession,
} from './helpers';
import type { ListOptions, SessionOption } from './types';

type DateRangeFilter = {
  $gte?: Date;
  $lte?: Date;
};

export type PurchaseListFilter = {
  studentId?: string | Types.ObjectId;
  testSeriesId?: string | Types.ObjectId;
  status?: string;
  createdAt?: DateRangeFilter;
  $or?: Array<Record<string, unknown>>;
};

export type EntitlementListFilter = {
  studentId?: string | Types.ObjectId;
  testSeriesId?: string | Types.ObjectId;
  status?: string;
  grantedAt?: DateRangeFilter;
  $or?: Array<Record<string, unknown>>;
};

export const purchaseRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(PurchaseModel, id, options);
  },

  findByStudentAndTestSeries(
    studentId: string | Types.ObjectId,
    testSeriesId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(PurchaseModel.find({ studentId, testSeriesId }), options?.session).exec();
  },

  findPendingByStudentAndTestSeries(
    studentId: string | Types.ObjectId,
    testSeriesId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      PurchaseModel.findOne({ studentId, testSeriesId, status: 'PENDING' }).sort({ createdAt: -1 }),
      options?.session,
    ).exec();
  },

  findPendingCreatedBefore(cutoff: Date, options?: SessionOption) {
    return withSession(
      PurchaseModel.find({ status: 'PENDING', createdAt: { $lt: cutoff } }),
      options?.session,
    ).exec();
  },

  markFailedIfPending(id: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      PurchaseModel.findOneAndUpdate(
        { _id: id, status: 'PENDING' },
        { $set: { status: 'FAILED' } },
        { returnDocument: 'after', runValidators: true },
      ),
      options?.session,
    ).exec();
  },

  findByRazorpayOrderId(razorpayOrderId: string, options?: SessionOption) {
    return withSession(PurchaseModel.findOne({ razorpayOrderId }), options?.session).exec();
  },

  findByRazorpayPaymentId(razorpayPaymentId: string, options?: SessionOption) {
    return withSession(PurchaseModel.findOne({ razorpayPaymentId }), options?.session).exec();
  },

  list(filter: PurchaseListFilter, options?: ListOptions) {
    return listDocuments(PurchaseModel, filter, options);
  },

  count(filter: PurchaseListFilter, options?: SessionOption) {
    return countDocuments(PurchaseModel, filter, options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(PurchaseModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(PurchaseModel, id, update, options);
  },
};

export const entitlementRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(EntitlementModel, id, options);
  },

  findByStudentAndTestSeries(
    studentId: string | Types.ObjectId,
    testSeriesId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(EntitlementModel.find({ studentId, testSeriesId }), options?.session).exec();
  },

  findActiveByStudentAndTestSeries(
    studentId: string | Types.ObjectId,
    testSeriesId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      EntitlementModel.findOne({ studentId, testSeriesId, status: 'ACTIVE' }),
      options?.session,
    ).exec();
  },

  findByPurchaseId(purchaseId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(EntitlementModel.findOne({ purchaseId }), options?.session).exec();
  },

  list(filter: EntitlementListFilter, options?: ListOptions) {
    return listDocuments(EntitlementModel, filter, options);
  },

  count(filter: EntitlementListFilter, options?: SessionOption) {
    return countDocuments(EntitlementModel, filter, options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(EntitlementModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(EntitlementModel, id, update, options);
  },
};
