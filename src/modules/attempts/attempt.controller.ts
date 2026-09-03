import type { Request, Response } from 'express';

import type { UserStatus } from '../../database/models/enums';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { parsePagination } from '../../shared/http/pagination';
import {
  getActiveAttempt,
  getStudentAttempt,
  listStudentAttempts,
  startAttempt,
  submitAttempt,
  updateAttemptAnswers,
} from './attempt.service';
import {
  parseActiveAttemptQuery,
  parseAttemptId,
  parseAttemptListQuery,
  parseClaimExamSessionInput,
  parseStartAttemptInput,
  parseUpdateAttemptAnswersInput,
} from './attempt.validation';
import {
  claimExamSession,
  EXAM_SESSION_HEADER,
  parseExamSessionIdHeader,
  releaseExamSession,
} from './exam-session';

function requireAuth(req: Request): { userId: string; status: UserStatus } {
  if (!req.auth) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCodes.AUTHENTICATION_REQUIRED,
      message: 'Authentication required.',
    });
  }

  return { userId: req.auth.userId, status: req.auth.status };
}

function readExamSessionId(req: Request): string {
  return parseExamSessionIdHeader(req.headers[EXAM_SESSION_HEADER]);
}

export async function startAttemptController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuth(req).userId;
  const attempt = await startAttempt(studentId, parseStartAttemptInput(req.body));

  res.status(201).json({
    success: true,
    data: attempt,
  });
}

export async function listAttemptsController(req: Request, res: Response): Promise<void> {
  const studentId = requireAuth(req).userId;
  const result = await listStudentAttempts(
    studentId,
    parseAttemptListQuery(req.query as Record<string, unknown>),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getActiveAttemptController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const attempt = await getActiveAttempt(
    auth.userId,
    parseActiveAttemptQuery(req.query as Record<string, unknown>),
    auth.status,
  );

  res.status(200).json({
    success: true,
    data: attempt,
  });
}

export async function getAttemptController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const attempt = await getStudentAttempt(
    auth.userId,
    parseAttemptId(req.params.attemptId),
    auth.status,
  );

  res.status(200).json({
    success: true,
    data: attempt,
  });
}

export async function updateAttemptAnswersController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const attempt = await updateAttemptAnswers(
    auth.userId,
    parseAttemptId(req.params.attemptId),
    parseUpdateAttemptAnswersInput(req.body),
    auth.status,
    undefined,
    readExamSessionId(req),
  );

  res.status(200).json({
    success: true,
    data: attempt,
  });
}

export async function submitAttemptController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const result = await submitAttempt(
    auth.userId,
    parseAttemptId(req.params.attemptId),
    auth.status,
    undefined,
    readExamSessionId(req),
  );

  res.status(200).json({
    success: true,
    data: result,
  });
}

export async function claimExamSessionController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const { sessionId } = parseClaimExamSessionInput(req.body);
  const result = await claimExamSession(
    auth.userId,
    parseAttemptId(req.params.attemptId),
    sessionId,
  );

  res.status(200).json({
    success: true,
    data: result,
  });
}

export async function releaseExamSessionController(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await releaseExamSession(
    auth.userId,
    parseAttemptId(req.params.attemptId),
    readExamSessionId(req),
  );

  res.status(200).json({
    success: true,
    data: { released: true },
  });
}
