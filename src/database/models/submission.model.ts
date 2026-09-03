import { Schema, model, models } from 'mongoose';

import { optionalRef, requiredRef, timestampSchemaOptions } from './conventions';
import { COLLECTIONS, TEST_SERIES_TYPES } from './enums';

const submissionAnswerSchema = new Schema(
  {
    questionId: { type: Schema.Types.ObjectId, required: true },
    selectedOptionId: { type: String, default: null },
  },
  { _id: false },
);

const submissionSchema = new Schema(
  {
    attemptId: requiredRef('Attempt'),
    studentId: requiredRef('User'),
    type: { type: String, required: true, enum: TEST_SERIES_TYPES },
    submittedAt: { type: Date, required: true },
    answers: { type: [submissionAnswerSchema], default: undefined },
    editorDocument: { type: Schema.Types.Mixed, default: undefined },
    answerSheetFile: optionalRef('SubmissionFile'),
  },
  { ...timestampSchemaOptions, collection: COLLECTIONS.submissions },
);

submissionSchema.index({ attemptId: 1 }, { unique: true });
submissionSchema.index({ studentId: 1 });

export const SubmissionModel = models.Submission ?? model('Submission', submissionSchema);
