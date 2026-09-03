import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { toAdminQuestionDto, toStudentQuestionDto } from '../src/modules/questions/question.dto';
import {
  parseCreateQuestionInput,
  parseQuestionContentForType,
  parseUpdateQuestionInput,
} from '../src/modules/questions/question.validation';
import { AppError, ErrorCodes } from '../src/shared/errors/app-error';

const TEST_SERIES_ID = '64b0f2c3a1d2e3f4a5b6c7d8';

function expectValidation(fn: () => unknown, field?: string) {
  try {
    fn();
    expect.fail('Expected validation error');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(ErrorCodes.VALIDATION_ERROR);
    if (field) {
      expect((appError.details as { fields: Record<string, string> }).fields[field]).toBeDefined();
    }
  }
}

describe('question create validation', () => {
  it('parses a valid MCQ create body', () => {
    const parsed = parseCreateQuestionInput({
      testSeriesId: TEST_SERIES_ID,
      type: 'MCQ',
      position: 1,
      questionText: 'What is 2 + 2?',
      content: {
        options: [
          { id: 'A', text: '3' },
          { id: 'B', text: '4' },
        ],
        correctOptionId: 'B',
      },
    });

    expect(parsed.testSeriesId).toBe(TEST_SERIES_ID);
    expect(parsed.type).toBe('MCQ');
    expect(parsed.position).toBe(1);
  });

  it('rejects WRITTEN, DRAFT, and MongoDB operators', () => {
    expectValidation(
      () =>
        parseCreateQuestionInput({
          testSeriesId: TEST_SERIES_ID,
          type: 'WRITTEN',
          position: 1,
          questionText: 'Essay',
          content: {},
        }),
      'type',
    );

    expectValidation(
      () =>
        parseCreateQuestionInput({
          testSeriesId: TEST_SERIES_ID,
          position: 1,
          status: 'DRAFT',
          questionText: 'Draft',
          content: {},
        }),
      'status',
    );

    expectValidation(
      () =>
        parseCreateQuestionInput({
          testSeriesId: TEST_SERIES_ID,
          position: 1,
          $set: { position: 99 },
        }),
      '$set',
    );
  });

  it('rejects invalid MCQ content shapes', () => {
    expectValidation(
      () =>
        parseQuestionContentForType(
          'MCQ',
          {
            options: [],
            correctOptionId: 'A',
          },
          'Question?',
        ),
      'content.options',
    );

    expectValidation(
      () =>
        parseQuestionContentForType(
          'MCQ',
          {
            options: [
              { id: 'A', text: '1' },
              { id: 'A', text: '2' },
            ],
            correctOptionId: 'A',
          },
          'Question?',
        ),
      'content.options[1].id',
    );

    expectValidation(
      () =>
        parseQuestionContentForType(
          'MCQ',
          {
            options: [{ id: 'A', text: '1' }],
            correctOptionId: 'Z',
          },
          'Question?',
        ),
      'content.correctOptionId',
    );

    expectValidation(
      () =>
        parseQuestionContentForType(
          'MCQ',
          {
            options: [{ id: 'A', text: '1' }],
            correctOptionIds: ['A'],
          },
          'Question?',
        ),
      'content.correctOptionIds',
    );
  });

  it('rejects unsupported EDITOR capabilities and non-object PDF content', () => {
    expectValidation(
      () =>
        parseQuestionContentForType(
          'EDITOR',
          { body: 'Answer here', images: [{ url: 'x' }] },
          'Prompt',
        ),
      'content.images',
    );

    expectValidation(
      () => parseQuestionContentForType('EDITOR', { code: 'print(1)' }, 'Prompt'),
      'content.code',
    );

    expectValidation(() => parseQuestionContentForType('PDF', 'not-an-object', 'Q1'), 'content');
  });
});

describe('question update validation', () => {
  it('rejects parent reassignment and empty updates', () => {
    expectValidation(
      () =>
        parseUpdateQuestionInput({
          testSeriesId: TEST_SERIES_ID,
          position: 2,
        }),
      'testSeriesId',
    );

    expectValidation(() => parseUpdateQuestionInput({}), 'body');
  });
});

describe('question DTOs', () => {
  const question = {
    _id: new Types.ObjectId(),
    testSeriesId: new Types.ObjectId(TEST_SERIES_ID),
    type: 'MCQ' as const,
    position: 1,
    questionText: 'What is 2 + 2?',
    content: {
      options: [
        { id: 'A', text: '3' },
        { id: 'B', text: '4' },
      ],
      correctOptionId: 'B',
      secretKey: 'should-not-leak-to-student-as-answer',
    },
    status: 'ACTIVE' as const,
    createdAt: new Date('2026-08-14T10:00:00.000Z'),
    updatedAt: new Date('2026-08-14T10:00:00.000Z'),
  };

  it('exposes correctOptionId in admin DTOs', () => {
    const dto = toAdminQuestionDto(question);
    expect(dto.content.correctOptionId).toBe('B');
    expect(dto).not.toHaveProperty('_id');
    expect(dto).not.toHaveProperty('__v');
    expect(dto).not.toHaveProperty('deletedAt');
  });

  it('never exposes correctOptionId in student-safe DTOs', () => {
    const dto = toStudentQuestionDto(question);
    const serialized = JSON.stringify(dto);

    expect(serialized).not.toContain('correctOptionId');
    expect(dto.content).toEqual({
      options: [
        { id: 'A', text: '3' },
        { id: 'B', text: '4' },
      ],
    });
    expect(dto.content).not.toHaveProperty('secretKey');
  });
});
