import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '../src/shared/errors/app-error';
import {
  McqScoringError,
  normalizeScore,
  scoreMcqSubmission,
} from '../src/modules/evaluations/evaluation-scoring';
import {
  parseAssignEvaluatorInput,
  parseEmptyEvaluationBody,
  parseEvaluatorListQuery,
  parseUpdateEvaluationInput,
} from '../src/modules/evaluations/evaluation.validation';
import { EVALUATION_STATUSES } from '../src/database/models/enums';

describe('Phase 10 unit rules', () => {
  it('scores correct, incorrect, and unanswered MCQ answers from the snapshot', () => {
    const questions = Array.from({ length: 10 }, (_, index) => ({
      questionId: `q${index + 1}`,
      correctOptionId: 'B',
    }));
    const answers = [
      ...Array.from({ length: 7 }, (_, index) => ({
        questionId: `q${index + 1}`,
        selectedOptionId: 'B',
      })),
      { questionId: 'q8', selectedOptionId: 'A' },
      { questionId: 'q9', selectedOptionId: 'C' },
    ];

    const result = scoreMcqSubmission(questions, answers, {
      correctMarks: 4,
      incorrectMarks: -1,
      unansweredMarks: 0,
    });

    expect(result.score).toBe(26);
    expect(result.maxScore).toBe(40);
    expect(result.metrics).toEqual({
      correctCount: 7,
      incorrectCount: 2,
      unansweredCount: 1,
    });
  });

  it('normalizes scores to two decimal places with deterministic hundredths math', () => {
    expect(normalizeScore(1.234)).toBe(1.23);
    expect(normalizeScore(1.236)).toBe(1.24);
    expect(normalizeScore(3.75)).toBe(3.75);

    const result = scoreMcqSubmission(
      [
        { questionId: 'q1', correctOptionId: 'A' },
        { questionId: 'q2', correctOptionId: 'A' },
        { questionId: 'q3', correctOptionId: 'A' },
      ],
      [
        { questionId: 'q1', selectedOptionId: 'A' },
        { questionId: 'q2', selectedOptionId: 'A' },
        { questionId: 'q3', selectedOptionId: 'A' },
      ],
      { correctMarks: 1.25, incorrectMarks: -0.25, unansweredMarks: 0 },
    );

    expect(result.score).toBe(3.75);
    expect(result.maxScore).toBe(3.75);
  });

  it('uses the provided scoring snapshot rather than a later configuration', () => {
    const questions = [{ questionId: 'q1', correctOptionId: 'B' }];
    const answers = [{ questionId: 'q1', selectedOptionId: 'B' }];
    const original = scoreMcqSubmission(questions, answers, {
      correctMarks: 4,
      incorrectMarks: -1,
      unansweredMarks: 0,
    });
    const mutated = scoreMcqSubmission(questions, answers, {
      correctMarks: 5,
      incorrectMarks: -2,
      unansweredMarks: 0,
    });

    expect(original.score).toBe(4);
    expect(mutated.score).toBe(5);
  });

  it('fails closed when the answer key or scoring snapshot is missing', () => {
    expect(() =>
      scoreMcqSubmission([{ questionId: 'q1' }], [], {
        correctMarks: 4,
        incorrectMarks: -1,
        unansweredMarks: 0,
      }),
    ).toThrow(McqScoringError);

    expect(() =>
      scoreMcqSubmission([], [], { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 }),
    ).toThrow(McqScoringError);
  });

  it('rejects unknown, protected, and operator fields on evaluation mutations', () => {
    expect(() =>
      parseAssignEvaluatorInput({
        evaluatorId: '64b7f2c8a1d2e3f4a5b6c7d8',
        categoryId: '64b7f2c8a1d2e3f4a5b6c7d9',
      }),
    ).toThrow();

    expect(() =>
      parseUpdateEvaluationInput({
        score: 10,
        status: 'FINALIZED',
      }),
    ).toThrow();

    expect(() =>
      parseUpdateEvaluationInput({
        score: 10,
        $set: { status: 'FINALIZED' },
      }),
    ).toThrow();

    expect(() => parseUpdateEvaluationInput({ score: -1 })).toThrow();

    expect(() => parseUpdateEvaluationInput({ score: 10, maxScore: 100 })).toThrow();

    try {
      parseUpdateEvaluationInput({ score: -1 });
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCodes.VALIDATION_ERROR);
    }

    expect(() => parseEmptyEvaluationBody({ status: 'COMPLETED' })).toThrow();
    expect(() => parseEmptyEvaluationBody({})).not.toThrow();

    expect(() => parseEvaluatorListQuery({ evaluatorId: '64b7f2c8a1d2e3f4a5b6c7d8' })).toThrow();
    expect(() => parseEvaluatorListQuery({ categoryId: '64b7f2c8a1d2e3f4a5b6c7d8' })).toThrow();
  });

  it('does not persist REOPENED or ADMIN_REVIEW as evaluation statuses', () => {
    expect(EVALUATION_STATUSES).toEqual([
      'UNASSIGNED',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'FINALIZED',
    ]);
    expect(EVALUATION_STATUSES).not.toContain('REOPENED');
    expect(EVALUATION_STATUSES).not.toContain('ADMIN_REVIEW');
  });
});
