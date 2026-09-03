import { Schema, model, models } from 'mongoose';

import { createdAtOnlySchemaOptions, WEBHOOK_EVENT_TTL_SECONDS } from './conventions';
import { COLLECTIONS, WEBHOOK_PROVIDERS } from './enums';

const webhookEventSchema = new Schema(
  {
    provider: { type: String, required: true, enum: WEBHOOK_PROVIDERS },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    processedAt: { type: Date, default: null },
  },
  { ...createdAtOnlySchemaOptions, collection: COLLECTIONS.webhookEvents },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: WEBHOOK_EVENT_TTL_SECONDS });

export const WebhookEventModel = models.WebhookEvent ?? model('WebhookEvent', webhookEventSchema);
