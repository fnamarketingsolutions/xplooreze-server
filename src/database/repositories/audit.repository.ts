import type { Types } from 'mongoose';

import { AuditLogModel } from '../models/audit-log.model';
import { WebhookEventModel } from '../models/webhook-event.model';
import { createDocument, findById, updateById, withSession } from './helpers';
import type { SessionOption } from './types';

export const auditLogRepository = {
  create(data: object, options?: SessionOption) {
    return createDocument(AuditLogModel, data, options);
  },

  findByResource(
    resourceType: string,
    resourceId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      AuditLogModel.find({ 'resource.type': resourceType, 'resource.id': resourceId }),
      options?.session,
    ).exec();
  },
};

export const webhookEventRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(WebhookEventModel, id, options);
  },

  findByProviderAndEventId(provider: string, eventId: string, options?: SessionOption) {
    return withSession(WebhookEventModel.findOne({ provider, eventId }), options?.session).exec();
  },

  create(data: object, options?: SessionOption) {
    return createDocument(WebhookEventModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return updateById(WebhookEventModel, id, update, options);
  },
};
