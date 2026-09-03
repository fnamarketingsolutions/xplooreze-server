import { Types } from 'mongoose';

import { AttemptModel } from '../models/attempt.model';
import { EvaluationModel } from '../models/evaluation.model';
import { EvaluationRevisionModel } from '../models/evaluation-revision.model';
import { ResultModel } from '../models/result.model';
import { SubmissionModel } from '../models/submission.model';
import { countDocuments, createDocument, findById, listDocuments, withSession } from './helpers';
import type { ListOptions, SessionOption } from './types';

export const attemptRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(AttemptModel, id, options);
  },

  findOne(filter: object, options?: SessionOption) {
    return withSession(AttemptModel.findOne(filter), options?.session).exec();
  },

  findByStudentAndTestSeries(
    studentId: string | Types.ObjectId,
    testSeriesId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(AttemptModel.find({ studentId, testSeriesId }), options?.session).exec();
  },

  findByQuestionPaperFileId(questionPaperFileId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(AttemptModel.find({ questionPaperFileId }), options?.session).exec();
  },

  findInProgressByStudentAndTestSeries(
    studentId: string | Types.ObjectId,
    testSeriesId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      AttemptModel.findOne({ studentId, testSeriesId, status: 'IN_PROGRESS' }),
      options?.session,
    ).exec();
  },

  findRecoverableByStudentAndTestSeries(
    studentId: string | Types.ObjectId,
    testSeriesId: string | Types.ObjectId,
    options?: SessionOption,
  ) {
    return withSession(
      AttemptModel.findOne({
        studentId,
        testSeriesId,
        status: { $in: ['IN_PROGRESS', 'UPLOAD_PENDING'] },
      }).sort({ startedAt: -1 }),
      options?.session,
    ).exec();
  },

  countByEntitlementId(entitlementId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(AttemptModel.countDocuments({ entitlementId }), options?.session).exec();
  },

  async countByEntitlementIds(entitlementIds: (string | Types.ObjectId)[]) {
    if (entitlementIds.length === 0) {
      return new Map<string, number>();
    }

    const rows = await AttemptModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      {
        $match: {
          entitlementId: { $in: entitlementIds.map((id) => new Types.ObjectId(id.toString())) },
        },
      },
      { $group: { _id: '$entitlementId', count: { $sum: 1 } } },
    ]).exec();

    return new Map(rows.map((row) => [row._id.toString(), row.count]));
  },

  listByStudent(
    studentId: string | Types.ObjectId,
    options?: ListOptions & { testSeriesId?: string | Types.ObjectId },
  ) {
    const filter: Record<string, unknown> = { studentId };
    if (options?.testSeriesId) {
      filter.testSeriesId = options.testSeriesId;
    }

    let query = withSession(AttemptModel.find(filter), options?.session);

    if (options?.sort) {
      query = query.sort(options.sort);
    } else {
      query = query.sort({ startedAt: -1 });
    }

    if (options?.skip !== undefined) {
      query = query.skip(options.skip);
    }

    if (options?.limit !== undefined) {
      query = query.limit(options.limit);
    }

    return query.exec();
  },

  countByStudent(
    studentId: string | Types.ObjectId,
    options?: SessionOption & { testSeriesId?: string | Types.ObjectId },
  ) {
    const filter: Record<string, unknown> = { studentId };
    if (options?.testSeriesId) {
      filter.testSeriesId = options.testSeriesId;
    }
    return withSession(AttemptModel.countDocuments(filter), options?.session).exec();
  },

  create(data: object, options?: SessionOption) {
    return createDocument(AttemptModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return withSession(
      AttemptModel.findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true }),
      options?.session,
    ).exec();
  },

  /**
   * Optimistic concurrency update: matches expected version, then increments.
   * Returns null when the version does not match or filters fail.
   */
  updateIfVersion(
    id: string | Types.ObjectId,
    expectedVersion: number,
    filter: object,
    setFields: object,
    options?: SessionOption,
  ) {
    return withSession(
      AttemptModel.findOneAndUpdate(
        { _id: id, version: expectedVersion, ...filter },
        {
          $set: setFields,
          $inc: { version: 1 },
        },
        { returnDocument: 'after', runValidators: true },
      ),
      options?.session,
    ).exec();
  },

  /**
   * Atomically claim or refresh an exam session lock when free, expired, or
   * already owned by `sessionId`. Returns null when another session holds it.
   */
  claimExamSession(
    id: string | Types.ObjectId,
    studentId: string | Types.ObjectId,
    sessionId: string,
    expiresAt: Date,
    now: Date,
    options?: SessionOption,
  ) {
    return withSession(
      AttemptModel.findOneAndUpdate(
        {
          _id: id,
          studentId,
          status: { $in: ['IN_PROGRESS', 'UPLOAD_PENDING'] },
          $or: [
            { activeSessionId: null },
            { activeSessionId: { $exists: false } },
            { activeSessionId: sessionId },
            { activeSessionExpiresAt: null },
            { activeSessionExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            activeSessionId: sessionId,
            activeSessionExpiresAt: expiresAt,
          },
        },
        { returnDocument: 'after', runValidators: true },
      ),
      options?.session,
    ).exec();
  },

  releaseExamSession(
    id: string | Types.ObjectId,
    studentId: string | Types.ObjectId,
    sessionId: string,
    options?: SessionOption,
  ) {
    return withSession(
      AttemptModel.findOneAndUpdate(
        { _id: id, studentId, activeSessionId: sessionId },
        {
          $set: {
            activeSessionId: null,
            activeSessionExpiresAt: null,
          },
        },
        { returnDocument: 'after', runValidators: true },
      ),
      options?.session,
    ).exec();
  },
};

export const submissionRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(SubmissionModel, id, options);
  },

  findByAttemptId(attemptId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(SubmissionModel.findOne({ attemptId }), options?.session).exec();
  },

  create(data: object, options?: SessionOption) {
    return createDocument(SubmissionModel, data, options);
  },
};

export const evaluationRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(EvaluationModel, id, options);
  },

  findBySubmissionId(submissionId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(EvaluationModel.findOne({ submissionId }), options?.session).exec();
  },

  list(filter: object, options?: ListOptions) {
    return listDocuments(EvaluationModel, filter, options);
  },

  count(filter: object, options?: SessionOption) {
    return countDocuments(EvaluationModel, filter, options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(EvaluationModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return withSession(
      EvaluationModel.findByIdAndUpdate(id, update, {
        returnDocument: 'after',
        runValidators: true,
      }),
      options?.session,
    ).exec();
  },

  findOneAndUpdate(filter: object, update: object, options?: SessionOption) {
    return withSession(
      EvaluationModel.findOneAndUpdate(filter, update, {
        returnDocument: 'after',
        runValidators: true,
      }),
      options?.session,
    ).exec();
  },

  /**
   * Finds an evaluation assigned to the evaluator for any submission belonging to the given
   * test series. Used for evaluator authorization to question/answer file access.
   */
  async findAssignedForEvaluatorAndTestSeries(
    evaluatorId: string | Types.ObjectId,
    testSeriesId: string | Types.ObjectId,
  ) {
    const evaluations = await EvaluationModel.find({
      evaluatorId,
      status: { $in: ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FINALIZED'] },
    }).exec();

    if (evaluations.length === 0) {
      return null;
    }

    for (const evaluation of evaluations) {
      const submission = await SubmissionModel.findById(evaluation.submissionId).exec();

      if (!submission) {
        continue;
      }

      const attempt = await AttemptModel.findById(submission.attemptId).exec();

      if (attempt && attempt.testSeriesId.toString() === testSeriesId.toString()) {
        return evaluation;
      }
    }

    return null;
  },
};

export const evaluationRevisionRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(EvaluationRevisionModel, id, options);
  },

  listByEvaluationId(evaluationId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      EvaluationRevisionModel.find({ evaluationId }).sort({ revisionNumber: 1 }),
      options?.session,
    ).exec();
  },

  findLatestByEvaluationId(evaluationId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(
      EvaluationRevisionModel.findOne({ evaluationId }).sort({ revisionNumber: -1 }),
      options?.session,
    ).exec();
  },

  create(data: object, options?: SessionOption) {
    return createDocument(EvaluationRevisionModel, data, options);
  },

  findOneAndUpdate(filter: object, update: object, options?: SessionOption) {
    return withSession(
      EvaluationRevisionModel.findOneAndUpdate(filter, update, {
        returnDocument: 'after',
        runValidators: true,
      }),
      options?.session,
    ).exec();
  },
};

export type ResultListFilter = {
  studentId?: string | Types.ObjectId;
  testSeriesId?: string | Types.ObjectId;
  status?: string;
};

export const resultRepository = {
  findById(id: string | Types.ObjectId, options?: SessionOption) {
    return findById(ResultModel, id, options);
  },

  findByAttemptId(attemptId: string | Types.ObjectId, options?: SessionOption) {
    return withSession(ResultModel.findOne({ attemptId }), options?.session).exec();
  },

  list(filter: ResultListFilter, options?: ListOptions) {
    return listDocuments(ResultModel, filter, options);
  },

  count(filter: ResultListFilter, options?: SessionOption) {
    return countDocuments(ResultModel, filter, options);
  },

  create(data: object, options?: SessionOption) {
    return createDocument(ResultModel, data, options);
  },

  updateById(id: string | Types.ObjectId, update: object, options?: SessionOption) {
    return withSession(
      ResultModel.findByIdAndUpdate(id, update, {
        returnDocument: 'after',
        runValidators: true,
      }),
      options?.session,
    ).exec();
  },

  findOneAndUpdate(filter: object, update: object, options?: SessionOption) {
    return withSession(
      ResultModel.findOneAndUpdate(filter, update, {
        returnDocument: 'after',
        runValidators: true,
      }),
      options?.session,
    ).exec();
  },

  async upsertByAttemptId(
    attemptId: string | Types.ObjectId,
    setOnInsert: object,
    setFields: object,
    options?: SessionOption,
  ) {
    const result = await withSession(
      ResultModel.findOneAndUpdate(
        { attemptId },
        { $setOnInsert: setOnInsert, $set: setFields },
        {
          upsert: true,
          returnDocument: 'after',
          runValidators: true,
          includeResultMetadata: true,
        },
      ),
      options?.session,
    ).exec();

    return {
      document: result.value,
      upserted: result.lastErrorObject?.upserted != null,
    };
  },
};
