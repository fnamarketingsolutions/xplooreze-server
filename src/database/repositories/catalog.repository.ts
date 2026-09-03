import type { Types } from 'mongoose';

import type { CatalogStatus, TestSeriesType } from '../models/enums';
import { CategoryModel } from '../models/category.model';
import { ModuleModel } from '../models/module.model';
import { QuestionModel } from '../models/question.model';
import { TestSeriesModel } from '../models/test-series.model';
import {
  countDocuments,
  createDocument,
  findById,
  findByIds,
  listDocuments,
  updateById,
  withSession,
} from './helpers';
import type { ListOptions, SessionOption } from './types';

const NOT_DELETED = { deletedAt: null } as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type CategoryListFilter = {
  status?: CatalogStatus;
};

export type ModuleListFilter = {
  status?: CatalogStatus;
  categoryId?: string | Types.ObjectId | { $in: Array<string | Types.ObjectId> };
};

export type TestSeriesListFilter = {
  status?: CatalogStatus;
  type?: TestSeriesType;
  moduleId?: string | Types.ObjectId | { $in: Array<string | Types.ObjectId> };
  titleContains?: string;
  ids?: Array<string | Types.ObjectId>;
};

function toTestSeriesQuery(filter: TestSeriesListFilter): Record<string, unknown> {
  const { titleContains, ids, ...rest } = filter;
  const query: Record<string, unknown> = { ...rest, ...NOT_DELETED };

  if (titleContains && titleContains.trim() !== '') {
    query.title = { $regex: escapeRegex(titleContains.trim()), $options: 'i' };
  }

  if (ids) {
    query._id = { $in: ids };
  }

  return query;
}

export type QuestionListFilter = {
  status?: CatalogStatus;
  type?: TestSeriesType;
  testSeriesId?: string | Types.ObjectId | { $in: Array<string | Types.ObjectId> };
};

export const categoryRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(CategoryModel, id, options);
  },

  findByIds(ids: Array<string | Types.ObjectId>, options?: SessionOption) {
    return findByIds(CategoryModel, ids, options);
  },

  findActiveByName(name: string, options?: SessionOption) {
    return withSession(
      CategoryModel.findOne({ name, status: 'ACTIVE', ...NOT_DELETED }),
      options?.session,
    ).exec();
  },

  list(filter: CategoryListFilter, options?: ListOptions) {
    return listDocuments(CategoryModel, { ...filter, ...NOT_DELETED }, options);
  },

  count(filter: CategoryListFilter, options?: SessionOption) {
    return countDocuments(CategoryModel, { ...filter, ...NOT_DELETED }, options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(CategoryModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(CategoryModel, id, update, options);
  },

  softDeleteById(id: string | Types.ObjectId, deletedAt: Date, options?: SessionOption) {
    return updateById(CategoryModel, id, { $set: { deletedAt } }, options);
  },
};

export const moduleRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(ModuleModel, id, options);
  },

  findByIds(ids: Array<string | Types.ObjectId>, options?: SessionOption) {
    return findByIds(ModuleModel, ids, options);
  },

  findByCategoryId(categoryId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(ModuleModel.find({ categoryId }), options?.session).exec();
  },

  findActiveByCategoryAndName(
    categoryId: string | Types.ObjectId,
    name: string,
    options?: SessionOption,
  ) {
    return withSession(
      ModuleModel.findOne({ categoryId, name, status: 'ACTIVE', ...NOT_DELETED }),
      options?.session,
    ).exec();
  },

  list(filter: ModuleListFilter, options?: ListOptions) {
    return listDocuments(ModuleModel, { ...filter, ...NOT_DELETED }, options);
  },

  count(filter: ModuleListFilter, options?: SessionOption) {
    return countDocuments(ModuleModel, { ...filter, ...NOT_DELETED }, options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(ModuleModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(ModuleModel, id, update, options);
  },

  softDeleteById(id: string | Types.ObjectId, deletedAt: Date, options?: SessionOption) {
    return updateById(ModuleModel, id, { $set: { deletedAt } }, options);
  },
};

export const testSeriesRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(TestSeriesModel, id, options);
  },

  findByIds(ids: Array<string | Types.ObjectId>, options?: SessionOption) {
    return findByIds(TestSeriesModel, ids, options);
  },

  findByModuleId(moduleId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(TestSeriesModel.find({ moduleId }), options?.session).exec();
  },

  list(filter: TestSeriesListFilter, options?: ListOptions) {
    return listDocuments(TestSeriesModel, toTestSeriesQuery(filter), options);
  },

  count(filter: TestSeriesListFilter, options?: SessionOption) {
    return countDocuments(TestSeriesModel, toTestSeriesQuery(filter), options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(TestSeriesModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(TestSeriesModel, id, update, options);
  },

  softDeleteById(id: string | Types.ObjectId, deletedAt: Date, options?: SessionOption) {
    return updateById(TestSeriesModel, id, { $set: { deletedAt } }, options);
  },
};

export const questionRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(QuestionModel, id, options);
  },

  findByTestSeriesId(testSeriesId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      QuestionModel.find({ testSeriesId, ...NOT_DELETED }).sort({ position: 1 }),
      options?.session,
    ).exec();
  },

  list(filter: QuestionListFilter, options?: ListOptions) {
    return listDocuments(QuestionModel, { ...filter, ...NOT_DELETED }, options);
  },

  count(filter: QuestionListFilter, options?: SessionOption) {
    return countDocuments(QuestionModel, { ...filter, ...NOT_DELETED }, options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(QuestionModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(QuestionModel, id, update, options);
  },

  softDeleteById(id: string | Types.ObjectId, deletedAt: Date, options?: SessionOption) {
    return updateById(QuestionModel, id, { $set: { deletedAt } }, options);
  },
};
