import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '../src/shared/errors/app-error';
import { snapshotResultScores } from '../src/modules/results/result.service';
import { toAdminResultDto, toStudentResultDto } from '../src/modules/results/result.dto';
import {
  parseAdminResultListQuery,
  parseEmptyResultBody,
  parseResultId,
  parseStudentResultListQuery,
} from '../src/modules/results/result.validation';

describe('Phase 11 result unit rules', () => {
  it('preserves 2-decimal score precision and computes percentage from the evaluation snapshot', () => {
    expect(snapshotResultScores(80, 100)).toEqual({
      score: 80,
      maxScore: 100,
      percentage: 80,
    });
    expect(snapshotResultScores(18.456, 20)).toEqual({
      score: 18.46,
      maxScore: 20,
      percentage: 92.3,
    });
    expect(snapshotResultScores(3, 12)).toEqual({
      score: 3,
      maxScore: 12,
      percentage: 25,
    });
  });

  it('does not invent a maxScore when the finalized revision omitted one', () => {
    expect(() => snapshotResultScores(80, null as unknown as number)).toThrow();
    expect(() => snapshotResultScores(80, 0)).toThrow();
    try {
      snapshotResultScores(80, 0);
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCodes.INVALID_SCORE);
    }
  });

  it('computes PDF/EDITOR percentages from snapshotted maxScore at 2 decimals', () => {
    expect(snapshotResultScores(82.5, 100)).toEqual({
      score: 82.5,
      maxScore: 100,
      percentage: 82.5,
    });
    expect(snapshotResultScores(42.5, 50)).toEqual({
      score: 42.5,
      maxScore: 50,
      percentage: 85,
    });
  });

  it('maps a student-safe DTO without evaluation internals', () => {
    const result = {
      _id: { toString: () => 'aaaaaaaaaaaaaaaaaaaaaaaa' },
      studentId: { toString: () => 'bbbbbbbbbbbbbbbbbbbbbbbb' },
      testSeriesId: { toString: () => 'cccccccccccccccccccccccc' },
      attemptId: { toString: () => 'dddddddddddddddddddddddd' },
      submissionId: { toString: () => 'eeeeeeeeeeeeeeeeeeeeeeee' },
      evaluationId: { toString: () => 'ffffffffffffffffffffffff' },
      score: 80,
      maxScore: 100,
      percentage: 80,
      status: 'PUBLISHED' as const,
      publishedAt: new Date('2026-08-14T12:00:00.000Z'),
      createdAt: new Date('2026-08-14T12:00:00.000Z'),
      updatedAt: new Date('2026-08-14T12:00:00.000Z'),
    };

    expect(toStudentResultDto(result)).toEqual({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      attemptId: 'dddddddddddddddddddddddd',
      testSeriesId: 'cccccccccccccccccccccccc',
      score: 80,
      maxScore: 100,
      percentage: 80,
      status: 'PUBLISHED',
      publishedAt: '2026-08-14T12:00:00.000Z',
      testSeries: null,
    });
    expect(toStudentResultDto(result)).not.toHaveProperty('evaluationId');
    expect(toStudentResultDto(result)).not.toHaveProperty('remarks');
    expect(toStudentResultDto(result)).not.toHaveProperty('evaluatorId');
    expect(toStudentResultDto(result)).not.toHaveProperty('_id');

    expect(toAdminResultDto(result).evaluationId).toBe('ffffffffffffffffffffffff');
    expect(toAdminResultDto(result).studentId).toBe('bbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('rejects client-controlled Result identity and score fields', () => {
    expect(() => parseStudentResultListQuery({ studentId: 'aaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow();
    expect(() => parseStudentResultListQuery({ attemptId: 'aaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow();
    expect(() => parseStudentResultListQuery({ score: '80' })).toThrow();
    expect(() => parseStudentResultListQuery({ status: 'PUBLISHED' })).toThrow();
    expect(() => parseStudentResultListQuery({ $gt: '1' })).toThrow();
    expect(() => parseStudentResultListQuery({ unknown: 'x' })).toThrow();
    expect(() => parseAdminResultListQuery({ evaluationRevisionId: 'x' })).toThrow();
    expect(() => parseEmptyResultBody({ score: 99 })).toThrow();
    expect(() => parseEmptyResultBody({ status: 'PUBLISHED' })).toThrow();
    expect(() => parseResultId('not-an-id')).toThrow();

    try {
      parseStudentResultListQuery({ studentId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCodes.VALIDATION_ERROR);
    }
  });
});
