import type { UserRole, UserStatus } from '../../database/models/enums';

export type AssignmentEvaluatorDto = {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  name: {
    first: string;
    last: string;
  };
};

export type AssignmentCategoryDto = {
  id: string;
  name: string;
};

export type EvaluatorCategoryAssignmentDto = {
  id: string;
  evaluatorId: string;
  evaluator: AssignmentEvaluatorDto | null;
  categoryId: string;
  category: AssignmentCategoryDto | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EvaluatorCategoryAssignmentGrantDto = {
  id: string;
  categoryId: string;
  category: AssignmentCategoryDto | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GroupedEvaluatorCategoryAssignmentsDto = {
  evaluatorId: string;
  evaluator: AssignmentEvaluatorDto | null;
  assignments: EvaluatorCategoryAssignmentGrantDto[];
};

type AssignmentLike = {
  _id: { toString(): string };
  evaluatorId: { toString(): string };
  categoryId: { toString(): string };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type EvaluatorLike = {
  _id: { toString(): string };
  email: string;
  role: UserRole;
  status: UserStatus;
  name: {
    first: string;
    last: string;
  };
};

type CategoryLike = {
  _id: { toString(): string };
  name: string;
};

function toAssignmentEvaluatorDto(evaluator: EvaluatorLike): AssignmentEvaluatorDto {
  return {
    id: evaluator._id.toString(),
    email: evaluator.email,
    role: evaluator.role,
    status: evaluator.status,
    name: {
      first: evaluator.name.first,
      last: evaluator.name.last,
    },
  };
}

function toAssignmentCategoryDto(category: CategoryLike): AssignmentCategoryDto {
  return {
    id: category._id.toString(),
    name: category.name,
  };
}

export function toEvaluatorCategoryAssignmentGrantDto(
  assignment: AssignmentLike,
  category: CategoryLike | null,
): EvaluatorCategoryAssignmentGrantDto {
  return {
    id: assignment._id.toString(),
    categoryId: assignment.categoryId.toString(),
    category: category ? toAssignmentCategoryDto(category) : null,
    isActive: assignment.isActive,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  };
}

export function toEvaluatorCategoryAssignmentDto(
  assignment: AssignmentLike,
  evaluator: EvaluatorLike | null,
  category: CategoryLike | null,
): EvaluatorCategoryAssignmentDto {
  return {
    id: assignment._id.toString(),
    evaluatorId: assignment.evaluatorId.toString(),
    evaluator: evaluator ? toAssignmentEvaluatorDto(evaluator) : null,
    categoryId: assignment.categoryId.toString(),
    category: category ? toAssignmentCategoryDto(category) : null,
    isActive: assignment.isActive,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  };
}

export function toGroupedEvaluatorCategoryAssignmentsDto(
  evaluatorId: string,
  evaluator: EvaluatorLike | null,
  assignments: EvaluatorCategoryAssignmentGrantDto[],
): GroupedEvaluatorCategoryAssignmentsDto {
  return {
    evaluatorId,
    evaluator: evaluator ? toAssignmentEvaluatorDto(evaluator) : null,
    assignments,
  };
}
