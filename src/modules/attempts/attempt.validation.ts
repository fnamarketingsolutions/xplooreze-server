import {
  asRecord,
  readNumber,
  readObjectId,
  readOptionalObjectIdQuery,
  readRouteParam,
  rejectUnknownFields,
  validationError,
} from '../../shared/validation/http';
import { parseExamSessionIdValue } from './exam-session';

const START_FIELDS = ['testSeriesId'] as const;
const ANSWER_UPDATE_FIELDS = ['version', 'answers', 'editorDocument'] as const;
const MCQ_ANSWER_FIELDS = ['questionId', 'selectedOptionId'] as const;
const CLAIM_SESSION_FIELDS = ['sessionId'] as const;

export type StartAttemptInput = {
  testSeriesId: string;
};

export type McqAnswerInput = {
  questionId: string;
  selectedOptionId: string;
};

export type UpdateAttemptAnswersInput = {
  version: number;
  answers?: McqAnswerInput[];
  editorDocument?: unknown;
};

export type AttemptListQuery = {
  testSeriesId?: string;
};

export type ActiveAttemptQuery = {
  testSeriesId: string;
};

export function parseStartAttemptInput(body: unknown): StartAttemptInput {
  const record = asRecord(body);
  rejectUnknownFields(record, START_FIELDS);

  return {
    testSeriesId: readObjectId(record.testSeriesId, 'testSeriesId'),
  };
}

export function parseAttemptId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'attemptId');
}

export function parseAttemptListQuery(query: Record<string, unknown>): AttemptListQuery {
  return {
    testSeriesId: readOptionalObjectIdQuery(query, 'testSeriesId'),
  };
}

export function parseActiveAttemptQuery(query: Record<string, unknown>): ActiveAttemptQuery {
  const testSeriesId = readOptionalObjectIdQuery(query, 'testSeriesId');

  if (!testSeriesId) {
    throw validationError({ testSeriesId: 'Must be a valid id.' });
  }

  return { testSeriesId };
}

export type ClaimExamSessionInput = {
  sessionId: string;
};

export function parseClaimExamSessionInput(body: unknown): ClaimExamSessionInput {
  const record = asRecord(body);
  rejectUnknownFields(record, CLAIM_SESSION_FIELDS);

  if (record.sessionId === undefined) {
    throw validationError({ sessionId: 'Required.' });
  }

  return {
    sessionId: parseExamSessionIdValue(record.sessionId, 'sessionId'),
  };
}

function parseMcqAnswer(value: unknown, index: number): McqAnswerInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ [`answers[${index}]`]: 'Must be an object.' });
  }

  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, MCQ_ANSWER_FIELDS);

  if (record.questionId === undefined) {
    throw validationError({ [`answers[${index}].questionId`]: 'Required.' });
  }

  if (record.selectedOptionId === undefined) {
    throw validationError({ [`answers[${index}].selectedOptionId`]: 'Required.' });
  }

  if (typeof record.selectedOptionId !== 'string' || record.selectedOptionId.trim() === '') {
    throw validationError({
      [`answers[${index}].selectedOptionId`]: 'Must be a non-empty string.',
    });
  }

  return {
    questionId: readObjectId(record.questionId, `answers[${index}].questionId`),
    selectedOptionId: record.selectedOptionId.trim(),
  };
}

export function parseUpdateAttemptAnswersInput(body: unknown): UpdateAttemptAnswersInput {
  const record = asRecord(body);
  rejectUnknownFields(record, ANSWER_UPDATE_FIELDS);

  if (record.version === undefined) {
    throw validationError({ version: 'Required.' });
  }

  const version = readNumber(record.version, 'version');

  if (!Number.isInteger(version) || version < 1) {
    throw validationError({ version: 'Must be a positive integer.' });
  }

  const hasAnswers = record.answers !== undefined;
  const hasEditor = record.editorDocument !== undefined;

  if (!hasAnswers && !hasEditor) {
    throw validationError({ body: 'At least one of answers or editorDocument is required.' });
  }

  if (hasAnswers && hasEditor) {
    throw validationError({
      body: 'Provide either answers or editorDocument, not both.',
    });
  }

  if (hasAnswers) {
    if (!Array.isArray(record.answers)) {
      throw validationError({ answers: 'Must be an array.' });
    }

    return {
      version,
      answers: record.answers.map((entry, index) => parseMcqAnswer(entry, index)),
    };
  }

  if (
    record.editorDocument === null ||
    typeof record.editorDocument !== 'object' ||
    Array.isArray(record.editorDocument)
  ) {
    throw validationError({ editorDocument: 'Must be a JSON object.' });
  }

  const editorRecord = record.editorDocument as Record<string, unknown>;
  const forbidden = ['code', 'language', 'testCases', 'stdin', 'stdout', 'execution', 'sandbox'];

  for (const key of forbidden) {
    if (key in editorRecord) {
      throw validationError({ [`editorDocument.${key}`]: 'Field is not allowed.' });
    }
  }

  return {
    version,
    editorDocument: record.editorDocument,
  };
}
