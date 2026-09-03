import type { ClientSession, Model } from 'mongoose';
import type { Types } from 'mongoose';

import type { ListOptions, SessionOption } from './types';

export function withSession<T extends { session: (session: ClientSession | null) => T }>(
  query: T,
  session?: ClientSession,
): T {
  if (session) {
    return query.session(session);
  }
  return query;
}

export async function findById<T>(
  model: Model<T>,
  id: string | Types.ObjectId,
  options?: SessionOption,
) {
  return withSession(model.findById(id), options?.session).exec();
}

export async function findByIds<T>(
  model: Model<T>,
  ids: Array<string | Types.ObjectId>,
  options?: SessionOption,
) {
  if (ids.length === 0) {
    return [];
  }

  return withSession(model.find({ _id: { $in: ids } }), options?.session).exec();
}

export async function createDocument<T>(model: Model<T>, data: object, options?: SessionOption) {
  const document = new model(data);
  await document.save({ session: options?.session });
  return document;
}

export async function updateById<T>(
  model: Model<T>,
  id: string | Types.ObjectId,
  update: object,
  options?: SessionOption,
) {
  return withSession(
    model.findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true }),
    options?.session,
  ).exec();
}

export async function listDocuments<T>(model: Model<T>, filter: object, options?: ListOptions) {
  let query = withSession(model.find(filter), options?.session);

  if (options?.sort) {
    query = query.sort(options.sort);
  }

  if (options?.skip !== undefined) {
    query = query.skip(options.skip);
  }

  if (options?.limit !== undefined) {
    query = query.limit(options.limit);
  }

  return query.exec();
}

export async function countDocuments<T>(model: Model<T>, filter: object, options?: SessionOption) {
  return withSession(model.countDocuments(filter), options?.session).exec();
}
