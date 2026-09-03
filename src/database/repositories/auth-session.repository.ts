import type { Types } from 'mongoose';

import { AuthSessionModel } from '../models/auth-session.model';
import { createDocument, findById, withSession } from './helpers';
import type { SessionOption } from './types';

export const authSessionRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(AuthSessionModel, id, options);
  },

  findByRefreshTokenHash(refreshTokenHash: string, options?: SessionOption) {
    return withSession(AuthSessionModel.findOne({ refreshTokenHash }), options?.session).exec();
  },

  create(data: object, options?: SessionOption) {
    return createDocument(AuthSessionModel, data, options);
  },

  async revokeIfActive(id: string | Types.ObjectId, revokedAt: Date, options?: SessionOption) {
    return withSession(
      AuthSessionModel.findOneAndUpdate(
        { _id: id, revokedAt: null },
        { $set: { revokedAt } },
        { returnDocument: 'after' },
      ),
      options?.session,
    ).exec();
  },

  async markReplaced(
    id: string | Types.ObjectId,
    replacedBySessionId: Types.ObjectId,
    revokedAt: Date,
    options?: SessionOption,
  ) {
    return withSession(
      AuthSessionModel.findOneAndUpdate(
        { _id: id, revokedAt: null },
        { $set: { revokedAt, replacedBySessionId } },
        { returnDocument: 'after' },
      ),
      options?.session,
    ).exec();
  },

  async revokeFamily(familyId: string, revokedAt: Date, options?: SessionOption) {
    return withSession(
      AuthSessionModel.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt } }),
      options?.session,
    ).exec();
  },

  async revokeAllForUser(
    userId: string | Types.ObjectId,
    revokedAt: Date,
    options?: SessionOption,
  ) {
    return withSession(
      AuthSessionModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt } }),
      options?.session,
    ).exec();
  },
};
