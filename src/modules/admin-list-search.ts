import type { Types } from 'mongoose';

import {
  categoryRepository,
  testSeriesRepository,
  userRepository,
} from '../database/repositories/index';

type StudentOrTestSeriesBranch =
  | { studentId: { $in: Types.ObjectId[] } }
  | { testSeriesId: { $in: Types.ObjectId[] } };

export type StudentOrTestSeriesSearchClause =
  | { kind: 'empty' }
  | { kind: 'match'; $or: StudentOrTestSeriesBranch[] };

/**
 * Resolve free-text admin search against students (name/email) and test series
 * titles into an `$or` clause for collections that only store foreign ids.
 */
export async function resolveStudentOrTestSeriesSearch(
  search: string,
): Promise<StudentOrTestSeriesSearchClause> {
  const trimmed = search.trim();
  if (trimmed === '') {
    return { kind: 'empty' };
  }

  const [studentIds, testSeriesIds] = await Promise.all([
    userRepository.listIds({ textContains: trimmed }),
    testSeriesRepository.listIds({ titleContains: trimmed }),
  ]);

  const $or: StudentOrTestSeriesBranch[] = [];

  if (studentIds.length > 0) {
    $or.push({ studentId: { $in: studentIds } });
  }
  if (testSeriesIds.length > 0) {
    $or.push({ testSeriesId: { $in: testSeriesIds } });
  }

  if ($or.length === 0) {
    return { kind: 'empty' };
  }

  return { kind: 'match', $or };
}

type EvaluatorOrCategoryBranch =
  | { evaluatorId: { $in: Types.ObjectId[] } }
  | { categoryId: { $in: Types.ObjectId[] } };

export type EvaluatorOrCategorySearchClause =
  | { kind: 'empty' }
  | { kind: 'match'; $or: EvaluatorOrCategoryBranch[] };

/**
 * Resolve free-text search against evaluator name/email and category names for
 * evaluator-category assignment membership filters.
 */
export async function resolveEvaluatorOrCategorySearch(
  search: string,
): Promise<EvaluatorOrCategorySearchClause> {
  const trimmed = search.trim();
  if (trimmed === '') {
    return { kind: 'empty' };
  }

  const [evaluatorIds, categoryIds] = await Promise.all([
    userRepository.listIds({ role: 'EVALUATOR', textContains: trimmed }),
    categoryRepository.listIds({ nameContains: trimmed }),
  ]);

  const $or: EvaluatorOrCategoryBranch[] = [];

  if (evaluatorIds.length > 0) {
    $or.push({ evaluatorId: { $in: evaluatorIds } });
  }
  if (categoryIds.length > 0) {
    $or.push({ categoryId: { $in: categoryIds } });
  }

  if ($or.length === 0) {
    return { kind: 'empty' };
  }

  return { kind: 'match', $or };
}
