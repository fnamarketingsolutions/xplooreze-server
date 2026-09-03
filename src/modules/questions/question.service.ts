import { remapDuplicateKey } from '../../database/errors';
import { questionRepository, testSeriesRepository } from '../../database/repositories/index';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { toAdminQuestionDto } from './question.dto';
import {
  parseQuestionContentForType,
  type AdminQuestionListQuery,
  type CreateQuestionInput,
  type UpdateQuestionInput,
} from './question.validation';

function questionNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.QUESTION_NOT_FOUND,
    message: 'Question not found.',
  });
}

function questionPositionConflict(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.QUESTION_POSITION_CONFLICT,
    message: 'A question with this position already exists in the test series.',
  });
}

function testSeriesNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.TEST_SERIES_NOT_FOUND,
    message: 'Test series not found.',
  });
}

async function requireExistingTestSeries(testSeriesId: string) {
  const testSeries = await testSeriesRepository.findById(testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw testSeriesNotFound();
  }

  return testSeries;
}

export async function listAdminQuestions(
  query: AdminQuestionListQuery,
  pagination: PaginationInput,
) {
  await requireExistingTestSeries(query.testSeriesId);

  const filter = {
    testSeriesId: query.testSeriesId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
  };

  const [items, total] = await Promise.all([
    questionRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { position: 1 },
    }),
    questionRepository.count(filter),
  ]);

  return {
    items: items.map((item) => toAdminQuestionDto(item)),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getAdminQuestion(questionId: string) {
  const question = await questionRepository.findById(questionId);

  if (!question || question.deletedAt != null) {
    throw questionNotFound();
  }

  const testSeries = await testSeriesRepository.findById(question.testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw questionNotFound();
  }

  return toAdminQuestionDto(question);
}

export async function createQuestion(input: CreateQuestionInput) {
  const testSeries = await requireExistingTestSeries(input.testSeriesId);

  if (input.type !== undefined && input.type !== testSeries.type) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Request validation failed.',
      details: {
        fields: {
          type: `Question type must match Test Series type (${testSeries.type}).`,
        },
      },
    });
  }

  const content = parseQuestionContentForType(testSeries.type, input.content, input.questionText);

  try {
    const created = await questionRepository.create({
      testSeriesId: input.testSeriesId,
      type: testSeries.type,
      position: input.position,
      questionText: input.questionText,
      content,
      status: input.status,
    });

    return toAdminQuestionDto(created);
  } catch (error) {
    remapDuplicateKey(error, questionPositionConflict());
  }
}

export async function updateQuestion(questionId: string, input: UpdateQuestionInput) {
  const existing = await questionRepository.findById(questionId);

  if (!existing || existing.deletedAt != null) {
    throw questionNotFound();
  }

  const testSeries = await testSeriesRepository.findById(existing.testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw questionNotFound();
  }

  const update: Record<string, unknown> = {};

  if (input.position !== undefined) {
    update.position = input.position;
  }

  if (input.status !== undefined) {
    update.status = input.status;
  }

  if (input.questionText !== undefined) {
    update.questionText = input.questionText;
  }

  if (input.content !== undefined || input.questionText !== undefined) {
    const questionText =
      input.questionText !== undefined ? input.questionText : (existing.questionText ?? '');
    const contentSource = input.content !== undefined ? input.content : existing.content;

    update.content = parseQuestionContentForType(existing.type, contentSource, questionText);

    if (input.questionText !== undefined) {
      update.questionText = input.questionText;
    }
  }

  try {
    const updated = await questionRepository.updateById(questionId, { $set: update });

    if (!updated || updated.deletedAt != null) {
      throw questionNotFound();
    }

    return toAdminQuestionDto(updated);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    remapDuplicateKey(error, questionPositionConflict());
  }
}

export async function deleteQuestion(questionId: string) {
  const existing = await questionRepository.findById(questionId);

  if (!existing || existing.deletedAt != null) {
    throw questionNotFound();
  }

  const deleted = await questionRepository.softDeleteById(questionId, new Date());

  if (!deleted) {
    throw questionNotFound();
  }

  return toAdminQuestionDto(deleted);
}
