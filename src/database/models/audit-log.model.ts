import { Schema, model, models } from 'mongoose';

import { AUDIT_LOG_TTL_SECONDS, createdAtOnlySchemaOptions, requiredRef } from './conventions';
import { COLLECTIONS, USER_ROLES } from './enums';

const auditLogSchema = new Schema(
  {
    actorUserId: requiredRef('User'),
    actorRole: { type: String, required: true, enum: USER_ROLES },
    action: { type: String, required: true },
    resource: {
      type: { type: String, required: true },
      id: { type: Schema.Types.ObjectId, required: true },
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { ...createdAtOnlySchemaOptions, collection: COLLECTIONS.auditLogs },
);

auditLogSchema.index({ actorUserId: 1 });
auditLogSchema.index({ action: 1 });
auditLogSchema.index({ 'resource.type': 1, 'resource.id': 1 });
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_LOG_TTL_SECONDS });

export const AuditLogModel = models.AuditLog ?? model('AuditLog', auditLogSchema);
