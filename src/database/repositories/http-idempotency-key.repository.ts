import type { Types } from 'mongoose';

import { HTTP_IDEMPOTENCY_TTL_MS } from '../models/conventions';
import { HttpIdempotencyKeyModel } from '../models/http-idempotency-key.model';
import { createDocument, withSession } from './helpers';
import type { SessionOption } from './types';

export type CreateHttpIdempotencyKeyInput = {
  userId: string | Types.ObjectId;
  operation: string;
  key: string;
  requestHash: string;
  expiresAt?: Date;
};

export type CompleteHttpIdempotencyKeyInput = {
  httpStatus: number;
  response: unknown;
};

export const httpIdempotencyKeyRepository = {
  create(data: CreateHttpIdempotencyKeyInput, options?: SessionOption) {
    return createDocument(
      HttpIdempotencyKeyModel,
      {
        userId: data.userId,
        operation: data.operation,
        key: data.key,
        requestHash: data.requestHash,
        status: 'PROCESSING',
        httpStatus: null,
        response: null,
        expiresAt: data.expiresAt ?? new Date(Date.now() + HTTP_IDEMPOTENCY_TTL_MS),
      },
      options,
    );
  },

  findByIdentity(
    userId: string | Types.ObjectId,
    operation: string,
    key: string,
    options?: SessionOption,
  ) {
    return withSession(
      HttpIdempotencyKeyModel.findOne({ userId, operation, key }),
      options?.session,
    ).exec();
  },

  completeIfProcessing(
    id: string | Types.ObjectId,
    input: CompleteHttpIdempotencyKeyInput,
    options?: SessionOption,
  ) {
    return withSession(
      HttpIdempotencyKeyModel.findOneAndUpdate(
        { _id: id, status: 'PROCESSING' },
        {
          $set: {
            status: 'COMPLETED',
            httpStatus: input.httpStatus,
            response: input.response,
          },
        },
        { returnDocument: 'after' },
      ),
      options?.session,
    ).exec();
  },

  deleteIfProcessing(id: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      HttpIdempotencyKeyModel.findOneAndDelete({ _id: id, status: 'PROCESSING' }),
      options?.session,
    ).exec();
  },
};
