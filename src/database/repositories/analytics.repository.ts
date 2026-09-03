import { Types } from 'mongoose';

import { AttemptModel } from '../models/attempt.model';
import { EntitlementModel } from '../models/entitlement.model';
import { EvaluationModel } from '../models/evaluation.model';
import { EvaluationRevisionModel } from '../models/evaluation-revision.model';
import {
  COLLECTIONS,
  EVALUATION_STATUSES,
  PURCHASE_STATUSES,
  RESULT_STATUSES,
  TEST_SERIES_TYPES,
} from '../models/enums';
import { PurchaseModel } from '../models/purchase.model';
import { ResultModel } from '../models/result.model';
import { TestSeriesModel } from '../models/test-series.model';
import { UserModel } from '../models/user.model';

const NOT_DELETED = { deletedAt: null } as const;

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

function toCountMap<T extends string>(
  rows: Array<{ _id: T | null; count: number }>,
  keys: readonly T[],
): Record<T, number> {
  const map = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const row of rows) {
    if (row._id != null && row._id in map) {
      map[row._id] = row.count;
    }
  }
  return map;
}

export const analyticsRepository = {
  countActiveStudents() {
    return UserModel.countDocuments({
      role: 'STUDENT',
      status: 'ACTIVE',
      ...NOT_DELETED,
    }).exec();
  },

  async sumPaidRevenuePaise(): Promise<number> {
    const [row] = await PurchaseModel.aggregate<{ total: number }>([
      { $match: { status: 'PAID' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).exec();
    return row?.total ?? 0;
  },

  countActiveEntitlements() {
    return EntitlementModel.countDocuments({ status: 'ACTIVE' }).exec();
  },

  countAttemptsInFlight() {
    return AttemptModel.countDocuments({
      status: { $in: ['IN_PROGRESS', 'UPLOAD_PENDING'] },
    }).exec();
  },

  countEvalBacklog() {
    return EvaluationModel.countDocuments({
      status: { $in: ['UNASSIGNED', 'COMPLETED'] },
    }).exec();
  },

  async groupEvaluationsByStatus() {
    const rows = await EvaluationModel.aggregate<{ _id: (typeof EVALUATION_STATUSES)[number]; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    return toCountMap(rows, EVALUATION_STATUSES);
  },

  async groupEvaluationsByStatusForEvaluator(evaluatorId: string | Types.ObjectId) {
    const rows = await EvaluationModel.aggregate<{
      _id: (typeof EVALUATION_STATUSES)[number];
      count: number;
    }>([
      { $match: { evaluatorId: toObjectId(evaluatorId), mode: 'MANUAL' } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    return toCountMap(rows, EVALUATION_STATUSES);
  },

  countEvaluationsForEvaluator(evaluatorId: string | Types.ObjectId) {
    return EvaluationModel.countDocuments({ evaluatorId, mode: 'MANUAL' }).exec();
  },

  /**
   * Daily revisions completed by an evaluator in [since, until).
   */
  async evaluatorCompletionsOverTime(
    evaluatorId: string | Types.ObjectId,
    since: Date,
    until: Date,
  ) {
    return EvaluationRevisionModel.aggregate<{ bucket: string; count: number }>([
      {
        $match: {
          evaluatorId: toObjectId(evaluatorId),
          completedAt: { $gte: since, $lt: until },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: 'UTC' },
          },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          bucket: '$_id',
          count: 1,
        },
      },
    ]).exec();
  },

  async groupPurchasesByStatus() {
    const rows = await PurchaseModel.aggregate<{ _id: (typeof PURCHASE_STATUSES)[number]; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    return toCountMap(rows, PURCHASE_STATUSES);
  },

  async groupActiveCatalogByType() {
    const rows = await TestSeriesModel.aggregate<{
      _id: (typeof TEST_SERIES_TYPES)[number];
      count: number;
    }>([
      { $match: { status: 'ACTIVE', ...NOT_DELETED } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]).exec();
    return toCountMap(rows, TEST_SERIES_TYPES);
  },

  async groupAttemptsByNumber() {
    const rows = await AttemptModel.aggregate<{ _id: number; count: number }>([
      { $group: { _id: '$attemptNumber', count: { $sum: 1 } } },
    ]).exec();
    return {
      '1': rows.find((row) => row._id === 1)?.count ?? 0,
      '2': rows.find((row) => row._id === 2)?.count ?? 0,
      '3': rows.find((row) => row._id === 3)?.count ?? 0,
    };
  },

  async groupResultsByStatus() {
    const rows = await ResultModel.aggregate<{ _id: (typeof RESULT_STATUSES)[number]; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    return toCountMap(rows, RESULT_STATUSES);
  },

  countEntitlementsExpiringBetween(from: Date, to: Date) {
    return EntitlementModel.countDocuments({
      status: 'ACTIVE',
      expiresAt: { $ne: null, $gte: from, $lte: to },
    }).exec();
  },

  /**
   * Daily attempt starts in [since, until), joined to Test Series type.
   */
  async attemptsByTypeOverTime(since: Date, until: Date) {
    return AttemptModel.aggregate<{
      bucket: string;
      type: (typeof TEST_SERIES_TYPES)[number];
      count: number;
    }>([
      {
        $match: {
          startedAt: { $gte: since, $lt: until },
        },
      },
      {
        $lookup: {
          from: COLLECTIONS.testSeries,
          localField: 'testSeriesId',
          foreignField: '_id',
          as: 'series',
        },
      },
      { $unwind: '$series' },
      {
        $group: {
          _id: {
            bucket: {
              $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: 'UTC' },
            },
            type: '$series.type',
          },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          bucket: '$_id.bucket',
          type: '$_id.type',
          count: 1,
        },
      },
    ]).exec();
  },

  /**
   * Daily PAID purchase revenue in [since, until).
   */
  async revenueOverTime(since: Date, until: Date) {
    return PurchaseModel.aggregate<{ bucket: string; amountPaise: number }>([
      {
        $match: {
          status: 'PAID',
          createdAt: { $gte: since, $lt: until },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' },
          },
          amountPaise: { $sum: '$amount' },
        },
      },
      {
        $project: {
          _id: 0,
          bucket: '$_id',
          amountPaise: 1,
        },
      },
    ]).exec();
  },
};
