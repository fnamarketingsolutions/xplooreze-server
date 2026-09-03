import type { ClientSession } from 'mongoose';

import { remapDuplicateKey } from '../../database/errors';
import type { UserRole } from '../../database/models/enums';
import {
  auditLogRepository,
  categoryRepository,
  evaluatorCategoryAssignmentRepository,
  userRepository,
} from '../../database/repositories/index';
import { withTransaction } from '../../database/transactions';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import {
  toEvaluatorCategoryAssignmentDto,
  toEvaluatorCategoryAssignmentGrantDto,
  toGroupedEvaluatorCategoryAssignmentsDto,
} from './evaluator-assignment.dto';
import type {
  CreateEvaluatorCategoryAssignmentInput,
  EvaluatorCategoryAssignmentListQuery,
  GroupedEvaluatorCategoryAssignmentListQuery,
  UpdateEvaluatorCategoryAssignmentInput,
} from './evaluator-assignment.validation';

export type AdminActor = {
  userId: string;
  role: UserRole;
};

function evaluatorNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.EVALUATOR_NOT_FOUND,
    message: 'Evaluator not found.',
  });
}

function invalidEvaluatorRole(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.INVALID_PRIVILEGED_ROLE,
    message: 'Assignments can only be created for Evaluator users.',
  });
}

function categoryNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.CATEGORY_NOT_FOUND,
    message: 'Category not found.',
  });
}

function assignmentNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.ASSIGNMENT_NOT_FOUND,
    message: 'Evaluator category assignment not found.',
  });
}

function assignmentConflict(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.EVALUATOR_CATEGORY_ASSIGNMENT_CONFLICT,
    message: 'An assignment already exists for this evaluator and category.',
  });
}

async function writeAudit(
  actor: AdminActor,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  session?: ClientSession,
) {
  await auditLogRepository.create(
    {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action,
      resource: { type: 'EvaluatorCategoryAssignment', id: resourceId },
      metadata,
    },
    session ? { session } : undefined,
  );
}

async function requireEvaluator(evaluatorId: string) {
  const evaluator = await userRepository.findById(evaluatorId);

  if (!evaluator || evaluator.deletedAt != null) {
    throw evaluatorNotFound();
  }

  if (evaluator.role !== 'EVALUATOR') {
    throw invalidEvaluatorRole();
  }

  return evaluator;
}

async function requireCategory(categoryId: string) {
  const category = await categoryRepository.findById(categoryId);

  if (!category || category.deletedAt != null) {
    throw categoryNotFound();
  }

  return category;
}

async function toDto(
  assignment: {
    _id: { toString(): string };
    evaluatorId: { toString(): string };
    categoryId: { toString(): string };
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  evaluator?: Awaited<ReturnType<typeof userRepository.findById>> | null,
  category?: Awaited<ReturnType<typeof categoryRepository.findById>> | null,
) {
  const [resolvedEvaluator, resolvedCategory] = await Promise.all([
    evaluator !== undefined
      ? Promise.resolve(evaluator)
      : userRepository.findById(assignment.evaluatorId.toString()),
    category !== undefined
      ? Promise.resolve(category)
      : categoryRepository.findById(assignment.categoryId.toString()),
  ]);

  return toEvaluatorCategoryAssignmentDto(
    assignment,
    resolvedEvaluator && resolvedEvaluator.deletedAt == null ? resolvedEvaluator : null,
    resolvedCategory && resolvedCategory.deletedAt == null ? resolvedCategory : null,
  );
}

export async function listEvaluatorCategoryAssignments(
  query: EvaluatorCategoryAssignmentListQuery,
  pagination: PaginationInput,
) {
  const filter: {
    categoryId?: string;
    evaluatorId?: string;
  } = {};

  if (query.categoryId) {
    filter.categoryId = query.categoryId;
  }

  if (query.evaluatorId) {
    filter.evaluatorId = query.evaluatorId;
  }

  const [items, total] = await Promise.all([
    evaluatorCategoryAssignmentRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { createdAt: -1 },
    }),
    evaluatorCategoryAssignmentRepository.count(filter),
  ]);

  const evaluatorIds = [...new Set(items.map((item) => item.evaluatorId.toString()))];
  const categoryIds = [...new Set(items.map((item) => item.categoryId.toString()))];
  const [evaluators, categories] = await Promise.all([
    userRepository.findByIds(evaluatorIds),
    categoryRepository.findByIds(categoryIds),
  ]);
  const evaluatorsById = new Map(
    evaluators.map((evaluator) => [evaluator._id.toString(), evaluator]),
  );
  const categoriesById = new Map(categories.map((category) => [category._id.toString(), category]));

  return {
    items: items.map((item) =>
      toEvaluatorCategoryAssignmentDto(
        item,
        evaluatorsById.get(item.evaluatorId.toString()) ?? null,
        categoriesById.get(item.categoryId.toString()) ?? null,
      ),
    ),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function listGroupedEvaluatorCategoryAssignments(
  query: GroupedEvaluatorCategoryAssignmentListQuery,
  pagination: PaginationInput,
) {
  const membershipFilter: {
    categoryId?: string;
    evaluatorId?: string;
    isActive?: boolean;
  } = {};

  if (query.categoryId) {
    membershipFilter.categoryId = query.categoryId;
  }

  if (query.evaluatorId) {
    membershipFilter.evaluatorId = query.evaluatorId;
  }

  if (query.isActive !== undefined) {
    membershipFilter.isActive = query.isActive;
  }

  const { evaluatorIds, total } =
    await evaluatorCategoryAssignmentRepository.listGroupedEvaluatorPage(
      membershipFilter,
      {
        skip: pagination.skip,
        limit: pagination.limit,
      },
    );

  const assignments = await evaluatorCategoryAssignmentRepository.listByEvaluatorIds(
    evaluatorIds,
  );
  const categoryIds = [...new Set(assignments.map((item) => item.categoryId.toString()))];
  const [evaluators, categories] = await Promise.all([
    userRepository.findByIds(evaluatorIds.map((id) => id.toString())),
    categoryRepository.findByIds(categoryIds),
  ]);
  const evaluatorsById = new Map(
    evaluators.map((evaluator) => [evaluator._id.toString(), evaluator]),
  );
  const categoriesById = new Map(categories.map((category) => [category._id.toString(), category]));
  const assignmentsByEvaluator = new Map<string, typeof assignments>();

  for (const assignment of assignments) {
    const evaluatorId = assignment.evaluatorId.toString();
    const existing = assignmentsByEvaluator.get(evaluatorId);

    if (existing) {
      existing.push(assignment);
    } else {
      assignmentsByEvaluator.set(evaluatorId, [assignment]);
    }
  }

  return {
    items: evaluatorIds.map((evaluatorObjectId) => {
      const evaluatorId = evaluatorObjectId.toString();
      const evaluator = evaluatorsById.get(evaluatorId) ?? null;
      const grants = (assignmentsByEvaluator.get(evaluatorId) ?? [])
        .map((assignment) => {
          const category = categoriesById.get(assignment.categoryId.toString()) ?? null;
          return toEvaluatorCategoryAssignmentGrantDto(
            assignment,
            category && category.deletedAt == null ? category : null,
          );
        })
        .sort((a, b) => {
          const byName = (a.category?.name || '').localeCompare(b.category?.name || '');
          if (byName !== 0) {
            return byName;
          }
          return a.createdAt.localeCompare(b.createdAt);
        });

      return toGroupedEvaluatorCategoryAssignmentsDto(
        evaluatorId,
        evaluator && evaluator.deletedAt == null ? evaluator : null,
        grants,
      );
    }),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function createEvaluatorCategoryAssignment(
  actor: AdminActor,
  input: CreateEvaluatorCategoryAssignmentInput,
) {
  const [evaluator, category] = await Promise.all([
    requireEvaluator(input.evaluatorId),
    requireCategory(input.categoryId),
  ]);

  const existing = await evaluatorCategoryAssignmentRepository.findByEvaluatorAndCategory(
    input.evaluatorId,
    input.categoryId,
  );

  if (existing) {
    throw assignmentConflict();
  }

  try {
    return await withTransaction(async (session) => {
      const created = await evaluatorCategoryAssignmentRepository.create(
        {
          evaluatorId: input.evaluatorId,
          categoryId: input.categoryId,
          isActive: true,
        },
        { session },
      );

      await writeAudit(
        actor,
        'EVALUATOR_CATEGORY_ASSIGNED',
        created._id.toString(),
        {
          evaluatorId: input.evaluatorId,
          categoryId: input.categoryId,
          isActive: true,
        },
        session,
      );

      return toDto(created, evaluator, category);
    });
  } catch (error) {
    remapDuplicateKey(error, assignmentConflict());
  }
}

export async function updateEvaluatorCategoryAssignment(
  actor: AdminActor,
  assignmentId: string,
  input: UpdateEvaluatorCategoryAssignmentInput,
) {
  const assignment = await evaluatorCategoryAssignmentRepository.findById(assignmentId);

  if (!assignment) {
    throw assignmentNotFound();
  }

  if (assignment.isActive === input.isActive) {
    return toDto(assignment);
  }

  const updated = await withTransaction(async (session) => {
    const next = await evaluatorCategoryAssignmentRepository.updateById(
      assignmentId,
      { $set: { isActive: input.isActive } },
      { session },
    );

    if (!next) {
      throw assignmentNotFound();
    }

    await writeAudit(
      actor,
      input.isActive ? 'EVALUATOR_CATEGORY_ACTIVATED' : 'EVALUATOR_CATEGORY_REMOVED',
      assignmentId,
      {
        evaluatorId: next.evaluatorId.toString(),
        categoryId: next.categoryId.toString(),
        isActive: input.isActive,
      },
      session,
    );

    return next;
  });

  return toDto(updated);
}
