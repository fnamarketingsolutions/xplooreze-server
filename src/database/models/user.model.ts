import { Schema, model, models } from 'mongoose';

import { timestampSchemaOptions } from './conventions';
import { COLLECTIONS, USER_ROLES, USER_STATUSES } from './enums';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: USER_ROLES },
    status: { type: String, required: true, enum: USER_STATUSES, default: 'ACTIVE' },
    name: {
      first: { type: String, required: true, trim: true },
      last: { type: String, required: true, trim: true },
    },
    deletedAt: { type: Date, default: null },
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.users },
);

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
userSchema.index({ role: 1 });
userSchema.index({ status: 1 });

export const UserModel = models.User ?? model('User', userSchema);
