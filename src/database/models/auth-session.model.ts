import { Schema, model, models } from 'mongoose';

import {
  REVOKED_AUTH_SESSION_TTL_SECONDS,
  optionalRef,
  requiredRef,
  timestampSchemaOptions,
} from './conventions';
import { COLLECTIONS } from './enums';

const authSessionSchema = new Schema(
  {
    userId: requiredRef('User'),
    familyId: { type: String, required: true },
    refreshTokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    replacedBySessionId: optionalRef('AuthSession'),
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.authSessions },
);

authSessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
authSessionSchema.index({ userId: 1 });
authSessionSchema.index({ familyId: 1 });
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
authSessionSchema.index(
  { revokedAt: 1 },
  { expireAfterSeconds: REVOKED_AUTH_SESSION_TTL_SECONDS },
);

export const AuthSessionModel = models.AuthSession ?? model('AuthSession', authSessionSchema);
