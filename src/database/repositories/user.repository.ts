import type { Types } from 'mongoose';

import type { UserRole, UserStatus } from '../models/enums';
import { UserModel } from '../models/user.model';
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

export type UserListFilter = {
  role?: UserRole;
  status?: UserStatus;
  ids?: Array<string | Types.ObjectId>;
};

function toUserQuery(filter: UserListFilter): Record<string, unknown> {
  const { ids, ...rest } = filter;

  return {
    ...rest,
    ...NOT_DELETED,
    ...(ids ? { _id: { $in: ids } } : {}),
  };
}

export const userRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(UserModel, id, options);
  },

  findByIds(ids: Array<string | Types.ObjectId>, options?: SessionOption) {
    return findByIds(UserModel, ids, options);
  },

  findByEmail(email: string, options?: SessionOption) {
    return withSession(UserModel.findOne({ email, deletedAt: null }), options?.session).exec();
  },

  findOne(filter: UserListFilter, options?: SessionOption) {
    return withSession(UserModel.findOne(toUserQuery(filter)), options?.session).exec();
  },

  list(filter: UserListFilter, options?: ListOptions) {
    return listDocuments(UserModel, toUserQuery(filter), options);
  },

  count(filter: UserListFilter, options?: SessionOption) {
    return countDocuments(UserModel, toUserQuery(filter), options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(UserModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(UserModel, id, update, options);
  },
};
