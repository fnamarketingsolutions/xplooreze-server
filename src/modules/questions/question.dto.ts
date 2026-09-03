import type { CatalogStatus, TestSeriesType } from '../../database/models/enums';

export type McqOptionDto = {
  id: string;
  text: string;
};

export type McqContentDto = {
  options: McqOptionDto[];
  correctOptionId: string;
};

export type StudentMcqContentDto = {
  options: McqOptionDto[];
};

export type AdminQuestionDto = {
  id: string;
  testSeriesId: string;
  type: TestSeriesType;
  position: number;
  questionText: string;
  content: Record<string, unknown>;
  status: CatalogStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * Student-safe question payload for future Attempt snapshot delivery.
 * Never includes correctOptionId or other answer-key fields.
 */
export type StudentQuestionDto = {
  id: string;
  testSeriesId: string;
  type: TestSeriesType;
  position: number;
  questionText: string;
  content: Record<string, unknown>;
};

type QuestionLike = {
  _id: { toString(): string };
  testSeriesId: { toString(): string };
  type: TestSeriesType;
  position: number;
  questionText?: string;
  content?: unknown;
  status: CatalogStatus;
  createdAt: Date;
  updatedAt: Date;
};

function asContentRecord(content: unknown): Record<string, unknown> {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return {};
  }

  return { ...(content as Record<string, unknown>) };
}

function toStudentContent(type: TestSeriesType, content: unknown): Record<string, unknown> {
  const record = asContentRecord(content);

  if (type !== 'MCQ') {
    return record;
  }

  const options = Array.isArray(record.options) ? record.options : [];
  const safeOptions: McqOptionDto[] = [];

  for (const option of options) {
    if (option === null || typeof option !== 'object' || Array.isArray(option)) {
      continue;
    }

    const entry = option as Record<string, unknown>;

    if (typeof entry.id === 'string' && typeof entry.text === 'string') {
      safeOptions.push({ id: entry.id, text: entry.text });
    }
  }

  return { options: safeOptions };
}

export function toAdminQuestionDto(question: QuestionLike): AdminQuestionDto {
  return {
    id: question._id.toString(),
    testSeriesId: question.testSeriesId.toString(),
    type: question.type,
    position: question.position,
    questionText: question.questionText ?? '',
    content: asContentRecord(question.content),
    status: question.status,
    createdAt: question.createdAt.toISOString(),
    updatedAt: question.updatedAt.toISOString(),
  };
}

export function toStudentQuestionDto(question: QuestionLike): StudentQuestionDto {
  return {
    id: question._id.toString(),
    testSeriesId: question.testSeriesId.toString(),
    type: question.type,
    position: question.position,
    questionText: question.questionText ?? '',
    content: toStudentContent(question.type, question.content),
  };
}
