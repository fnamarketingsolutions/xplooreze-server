import type { Types } from 'mongoose';

import { PasswordResetTokenModel } from '../models/password-reset-token.model';
import { createDocument, withSession } from './helpers';
import type { SessionOption } from './types';

export const passwordResetTokenRepository = {
  create(data: object, options?: SessionOption) {
    return createDocument(PasswordResetTokenModel, data, options);
  },

  consumeAvailableToken(tokenHash: string, now: Date, options?: SessionOption) {
    return withSession(
      PasswordResetTokenModel.findOneAndUpdate(
        {
          tokenHash,
          usedAt: null,
          expiresAt: { $gt: now },
        },
        { $set: { usedAt: now } },
        { returnDocument: 'after' },
      ),
      options?.session,
    ).exec();
  },

  invalidateAllForUser(userId: string | Types.ObjectId, usedAt: Date, options?: SessionOption) {
    return withSession(
      PasswordResetTokenModel.updateMany(
        {
          userId,
          usedAt: null,
        },
        { $set: { usedAt } },
      ),
      options?.session,
    ).exec();
  },

  findByTokenHash(tokenHash: string, options?: SessionOption) {
    return withSession(PasswordResetTokenModel.findOne({ tokenHash }), options?.session).exec();
  },

  listByUser(userId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      PasswordResetTokenModel.find({ userId }).sort({ createdAt: -1 }),
      options?.session,
    ).exec();
  },
};
