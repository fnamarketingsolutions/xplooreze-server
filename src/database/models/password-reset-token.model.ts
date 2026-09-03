import { Schema, model, models } from 'mongoose';

import { requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS } from './enums';

const passwordResetTokenSchema = new Schema(
  {
    userId: requiredRef('User'),
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.passwordResetTokens },
);

passwordResetTokenSchema.index({ tokenHash: 1 }, { unique: true });
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
passwordResetTokenSchema.index({ userId: 1 });

export const PasswordResetTokenModel =
  models.PasswordResetToken ?? model('PasswordResetToken', passwordResetTokenSchema);
