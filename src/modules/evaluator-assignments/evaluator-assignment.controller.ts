import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { parsePagination } from '../../shared/http/pagination';
import {
  createEvaluatorCategoryAssignment,
  listEvaluatorCategoryAssignments,
  listGroupedEvaluatorCategoryAssignments,
  updateEvaluatorCategoryAssignment,
} from './evaluator-assignment.service';
import {
  parseAssignmentId,
  parseCreateEvaluatorCategoryAssignmentInput,
  parseEvaluatorCategoryAssignmentListQuery,
  parseGroupedEvaluatorCategoryAssignmentListQuery,
  parseUpdateEvaluatorCategoryAssignmentInput,
} from './evaluator-assignment.validation';

function requireAdminActor(req: Request) {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  return { userId: req.auth.userId, role: req.auth.role };
}

export async function listEvaluatorCategoryAssignmentsController(
  req: Request,
  res: Response,
): Promise<void> {
  const result = await listEvaluatorCategoryAssignments(
    parseEvaluatorCategoryAssignmentListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function listGroupedEvaluatorCategoryAssignmentsController(
  req: Request,
  res: Response,
): Promise<void> {
  const result = await listGroupedEvaluatorCategoryAssignments(
    parseGroupedEvaluatorCategoryAssignmentListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function createEvaluatorCategoryAssignmentController(
  req: Request,
  res: Response,
): Promise<void> {
  const assignment = await createEvaluatorCategoryAssignment(
    requireAdminActor(req),
    parseCreateEvaluatorCategoryAssignmentInput(req.body),
  );

  res.status(201).json({
    success: true,
    data: assignment,
  });
}

export async function updateEvaluatorCategoryAssignmentController(
  req: Request,
  res: Response,
): Promise<void> {
  const assignment = await updateEvaluatorCategoryAssignment(
    requireAdminActor(req),
    parseAssignmentId(req.params.assignmentId),
    parseUpdateEvaluatorCategoryAssignmentInput(req.body),
  );

  res.status(200).json({
    success: true,
    data: assignment,
  });
}
