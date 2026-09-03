import type { Types } from 'mongoose';

import { AnswerFileModel } from '../models/answer-file.model';
import { AttemptModel } from '../models/attempt.model';
import { QuestionFileModel } from '../models/question-file.model';
import { SubmissionFileModel } from '../models/submission-file.model';
import { createDocument, findById, withSession } from './helpers';
import type { SessionOption } from './types';

export const questionFileRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(QuestionFileModel, id, options);
  },

  findByTestSeriesId(testSeriesId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(QuestionFileModel.find({ testSeriesId }), options?.session).exec();
  },

  findActiveByTestSeriesId(testSeriesId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      QuestionFileModel.findOne({ testSeriesId, status: 'ACTIVE', deletedAt: null }),
      options?.session,
    ).exec();
  },

  findByStatus(status: string, options?: SessionOption) {
    return withSession(QuestionFileModel.find({ status }), options?.session).exec();
  },

  findPendingCreatedBefore(cutoff: Date, options?: SessionOption) {
    return withSession(
      QuestionFileModel.find({ status: 'PENDING', createdAt: { $lt: cutoff } }),
      options?.session,
    ).exec();
  },

  create(data: object, options?: SessionOption) {
    return createDocument(QuestionFileModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return withSession(
      QuestionFileModel.findByIdAndUpdate(id, update, {
        returnDocument: 'after',
        runValidators: true,
      }),
      options?.session,
    ).exec();
  },

  markDeletedIfPending(
    id: string | Types.ObjectId,
    deletedAt: Date,
    options?: SessionOption,
  ) {
    return withSession(
      QuestionFileModel.findOneAndUpdate(
        {
          _id: id,
          status: 'PENDING',
          deletedAt: null,
        },
        { $set: { status: 'DELETED', deletedAt } },
        { returnDocument: 'after', runValidators: true },
      ),
      options?.session,
    ).exec();
  },

  markReplacedExcept(
    testSeriesId: string | Types.ObjectId,
    exceptId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      QuestionFileModel.updateMany(
        {
          testSeriesId,
          _id: { $ne: exceptId },
          status: 'ACTIVE',
          deletedAt: null,
        },
        { $set: { status: 'REPLACED' } },
      ),
      options?.session,
    ).exec();
  },
};

export const answerFileRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(AnswerFileModel, id, options);
  },

  findByTestSeriesId(testSeriesId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(AnswerFileModel.find({ testSeriesId }), options?.session).exec();
  },

  findActiveByTestSeriesId(testSeriesId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      AnswerFileModel.find({ testSeriesId, status: 'ACTIVE', deletedAt: null }),
      options?.session,
    ).exec();
  },

  findByStatus(status: string, options?: SessionOption) {
    return withSession(AnswerFileModel.find({ status }), options?.session).exec();
  },

  findPendingCreatedBefore(cutoff: Date, options?: SessionOption) {
    return withSession(
      AnswerFileModel.find({ status: 'PENDING', createdAt: { $lt: cutoff } }),
      options?.session,
    ).exec();
  },

  create(data: object, options?: SessionOption) {
    return createDocument(AnswerFileModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return withSession(
      AnswerFileModel.findByIdAndUpdate(id, update, {
        returnDocument: 'after',
        runValidators: true,
      }),
      options?.session,
    ).exec();
  },

  markDeletedIfPending(
    id: string | Types.ObjectId,
    deletedAt: Date,
    options?: SessionOption,
  ) {
    return withSession(
      AnswerFileModel.findOneAndUpdate(
        {
          _id: id,
          status: 'PENDING',
          deletedAt: null,
        },
        { $set: { status: 'DELETED', deletedAt } },
        { returnDocument: 'after', runValidators: true },
      ),
      options?.session,
    ).exec();
  },

  markDeletedIfPendingOrActive(
    id: string | Types.ObjectId,
    deletedAt: Date,
    options?: SessionOption,
  ) {
    return withSession(
      AnswerFileModel.findOneAndUpdate(
        {
          _id: id,
          status: { $in: ['PENDING', 'ACTIVE'] },
          deletedAt: null,
        },
        { $set: { status: 'DELETED', deletedAt } },
        { returnDocument: 'after', runValidators: true },
      ),
      options?.session,
    ).exec();
  },
};

export const submissionFileRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(SubmissionFileModel, id, options);
  },

  findBySubmissionId(submissionId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(SubmissionFileModel.find({ submissionId }), options?.session).exec();
  },

  findByAttemptId(attemptId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(SubmissionFileModel.find({ attemptId }), options?.session).exec();
  },

  findByStatus(status: string, options?: SessionOption) {
    return withSession(SubmissionFileModel.find({ status }), options?.session).exec();
  },

  findPendingCreatedBefore(cutoff: Date, options?: SessionOption) {
    return withSession(
      SubmissionFileModel.find({ status: 'PENDING', createdAt: { $lt: cutoff } }),
      options?.session,
    ).exec();
  },

  findReplacedForSubmittedAttempts(options?: SessionOption) {
    return withSession(
      SubmissionFileModel.find({ status: 'REPLACED', attemptId: { $ne: null } }),
      options?.session,
    )
      .exec()
      .then(async (files) => {
        if (files.length === 0) {
          return [];
        }

        const attemptIds = [
          ...new Set(
            files
              .map((file) => file.attemptId?.toString())
              .filter((id): id is string => typeof id === 'string'),
          ),
        ];

        const submittedAttempts = await withSession(
          AttemptModel.find({ _id: { $in: attemptIds }, status: 'SUBMITTED' }).select('_id'),
          options?.session,
        ).exec();

        const submittedIds = new Set(submittedAttempts.map((attempt) => attempt._id.toString()));

        return files.filter(
          (file) => file.attemptId != null && submittedIds.has(file.attemptId.toString()),
        );
      });
  },

  create(data: object, options?: SessionOption) {
    return createDocument(SubmissionFileModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return withSession(
      SubmissionFileModel.findByIdAndUpdate(id, update, {
        returnDocument: 'after',
        runValidators: true,
      }),
      options?.session,
    ).exec();
  },

  markDeletedIfPending(
    id: string | Types.ObjectId,
    deletedAt: Date,
    options?: SessionOption,
  ) {
    return withSession(
      SubmissionFileModel.findOneAndUpdate(
        {
          _id: id,
          status: 'PENDING',
          deletedAt: null,
        },
        { $set: { status: 'DELETED', deletedAt } },
        { returnDocument: 'after', runValidators: true },
      ),
      options?.session,
    ).exec();
  },

  markReplacedExcept(
    attemptId: string | Types.ObjectId,
    exceptId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      SubmissionFileModel.updateMany(
        {
          attemptId,
          _id: { $ne: exceptId },
          status: 'ACTIVE',
          deletedAt: null,
        },
        { $set: { status: 'REPLACED' } },
      ),
      options?.session,
    ).exec();
  },
};
