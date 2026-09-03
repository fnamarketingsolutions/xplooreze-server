import { Types } from 'mongoose';
import type { PipelineStage } from 'mongoose';

import { EvaluatorCategoryAssignmentModel } from '../models/evaluator-category-assignment.model';
import {
  countDocuments,
  createDocument,
  findById,
  listDocuments,
  updateById,
  withSession,
} from './helpers';
import type { ListOptions, SessionOption } from './types';

export type EvaluatorCategoryAssignmentListFilter = {
  evaluatorId?: string | Types.ObjectId;
  categoryId?: string | Types.ObjectId;
  isActive?: boolean;
};

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

function toMatch(filter: EvaluatorCategoryAssignmentListFilter): Record<string, unknown> {
  const match: Record<string, unknown> = {};

  if (filter.evaluatorId) {
    match.evaluatorId = toObjectId(filter.evaluatorId);
  }

  if (filter.categoryId) {
    match.categoryId = toObjectId(filter.categoryId);
  }

  if (filter.isActive !== undefined) {
    match.isActive = filter.isActive;
  }

  return match;
}

export const evaluatorCategoryAssignmentRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(EvaluatorCategoryAssignmentModel, id, options);
  },

  findByEvaluatorAndCategory(
    evaluatorId: string | Types.ObjectId,
    categoryId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      EvaluatorCategoryAssignmentModel.findOne({ evaluatorId, categoryId }),
      options?.session,
    ).exec();
  },

  findActiveByEvaluatorAndCategory(
    evaluatorId: string | Types.ObjectId,
    categoryId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      EvaluatorCategoryAssignmentModel.findOne({ evaluatorId, categoryId, isActive: true }),
      options?.session,
    ).exec();
  },

  findByEvaluatorId(evaluatorId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      EvaluatorCategoryAssignmentModel.find({ evaluatorId }),
      options?.session,
    ).exec();
  },

  list(filter: EvaluatorCategoryAssignmentListFilter, options?: ListOptions) {
    return listDocuments(EvaluatorCategoryAssignmentModel, filter, options);
  },

  listByEvaluatorIds(
    evaluatorIds: Array<string | Types.ObjectId>,
    options?: SessionOption,
  ) {
    if (evaluatorIds.length === 0) {
      return Promise.resolve([]);
    }

    return withSession(
      EvaluatorCategoryAssignmentModel.find({
        evaluatorId: { $in: evaluatorIds.map(toObjectId) },
      }).sort({ createdAt: 1 }),
      options?.session,
    ).exec();
  },

  async listGroupedEvaluatorPage(
    filter: EvaluatorCategoryAssignmentListFilter,
    options: { skip: number; limit: number } & SessionOption,
  ) {
    const pipeline: PipelineStage[] = [
      { $match: toMatch(filter) },
      {
        $group: {
          _id: '$evaluatorId',
          latestCreatedAt: { $max: '$createdAt' },
        },
      },
      { $sort: { latestCreatedAt: -1, _id: 1 } },
      {
        $facet: {
          total: [{ $count: 'count' }],
          page: [{ $skip: options.skip }, { $limit: options.limit }],
        },
      },
    ];

    const aggregation = EvaluatorCategoryAssignmentModel.aggregate<{
      total: Array<{ count: number }>;
      page: Array<{ _id: Types.ObjectId }>;
    }>(pipeline);

    if (options.session) {
      aggregation.session(options.session);
    }

    const [result] = await aggregation.exec();

    return {
      evaluatorIds: (result?.page ?? []).map((row) => row._id),
      total: result?.total[0]?.count ?? 0,
    };
  },

  count(filter: EvaluatorCategoryAssignmentListFilter, options?: SessionOption) {
    return countDocuments(EvaluatorCategoryAssignmentModel, filter, options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(EvaluatorCategoryAssignmentModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(EvaluatorCategoryAssignmentModel, id, update, options);
  },
};
