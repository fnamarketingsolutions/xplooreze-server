import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { parsePagination } from '../../shared/http/pagination';
import {
  assignEvaluator,
  completeEvaluation,
  finalizeEvaluation,
  getAdminEvaluation,
  getEvaluatorEvaluation,
  getEvaluatorSummary,
  listAdminEvaluations,
  listEvaluatorEvaluations,
  reopenEvaluation,
  startEvaluation,
  updateEvaluation,
} from './evaluation.service';
import {
  parseAdminEvaluationListQuery,
  parseAssignEvaluatorInput,
  parseEmptyEvaluationBody,
  parseEvaluationId,
  parseEvaluatorListQuery,
  parseUpdateEvaluationInput,
} from './evaluation.validation';

function requireAuth(req: Request): { userId: string; role: NonNullable<Request['auth']>['role'] } {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  return { userId: req.auth.userId, role: req.auth.role };
}

export async function listEvaluatorEvaluationsController(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = requireAuth(req);
  const result = await listEvaluatorEvaluations(
    auth.userId,
    parseEvaluatorListQuery(req.query as Record<string, unknown>),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getEvaluatorSummaryController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const summary = await getEvaluatorSummary(auth.userId);

  res.status(200).json({
    success: true,
    data: summary,
  });
}

export async function getEvaluatorEvaluationController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const evaluation = await getEvaluatorEvaluation(
    auth.userId,
    parseEvaluationId(req.params.evaluationId),
  );

  res.status(200).json({
    success: true,
    data: evaluation,
  });
}

export async function startEvaluationController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  parseEmptyEvaluationBody(req.body);
  const evaluation = await startEvaluation(auth.userId, parseEvaluationId(req.params.evaluationId));

  res.status(200).json({
    success: true,
    data: evaluation,
  });
}

export async function updateEvaluationController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const evaluation = await updateEvaluation(
    auth.userId,
    parseEvaluationId(req.params.evaluationId),
    parseUpdateEvaluationInput(req.body),
  );

  res.status(200).json({
    success: true,
    data: evaluation,
  });
}

export async function completeEvaluationController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  parseEmptyEvaluationBody(req.body);
  const evaluation = await completeEvaluation(
    auth.userId,
    parseEvaluationId(req.params.evaluationId),
  );

  res.status(200).json({
    success: true,
    data: evaluation,
  });
}

export async function listAdminEvaluationsController(req: Request, res: Response): Promise<void> {
  const result = await listAdminEvaluations(
    parseAdminEvaluationListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getAdminEvaluationController(req: Request, res: Response): Promise<void> {
  const evaluation = await getAdminEvaluation(parseEvaluationId(req.params.evaluationId));

  res.status(200).json({
    success: true,
    data: evaluation,
  });
}

export async function assignEvaluatorController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const evaluation = await assignEvaluator(
    auth,
    parseEvaluationId(req.params.evaluationId),
    parseAssignEvaluatorInput(req.body).evaluatorId,
  );

  res.status(200).json({
    success: true,
    data: evaluation,
  });
}

export async function finalizeEvaluationController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  parseEmptyEvaluationBody(req.body);
  const evaluation = await finalizeEvaluation(auth, parseEvaluationId(req.params.evaluationId));

  res.status(200).json({
    success: true,
    data: evaluation,
  });
}

export async function reopenEvaluationController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  parseEmptyEvaluationBody(req.body);
  const evaluation = await reopenEvaluation(auth, parseEvaluationId(req.params.evaluationId));

  res.status(200).json({
    success: true,
    data: evaluation,
  });
}
