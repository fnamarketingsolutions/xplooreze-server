import type { Request, Response } from 'express';

import { parsePagination } from '../../shared/http/pagination';
import {
  createQuestion,
  deleteQuestion,
  getAdminQuestion,
  listAdminQuestions,
  updateQuestion,
} from './question.service';
import {
  parseAdminQuestionListQuery,
  parseCreateQuestionInput,
  parseQuestionId,
  parseUpdateQuestionInput,
} from './question.validation';

export async function listAdminQuestionsController(req: Request, res: Response): Promise<void> {
  const result = await listAdminQuestions(
    parseAdminQuestionListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getAdminQuestionController(req: Request, res: Response): Promise<void> {
  const question = await getAdminQuestion(parseQuestionId(req.params.questionId));

  res.status(200).json({
    success: true,
    data: question,
  });
}

export async function createQuestionController(req: Request, res: Response): Promise<void> {
  const question = await createQuestion(parseCreateQuestionInput(req.body));

  res.status(201).json({
    success: true,
    data: question,
  });
}

export async function updateQuestionController(req: Request, res: Response): Promise<void> {
  const question = await updateQuestion(
    parseQuestionId(req.params.questionId),
    parseUpdateQuestionInput(req.body),
  );

  res.status(200).json({
    success: true,
    data: question,
  });
}

export async function deleteQuestionController(req: Request, res: Response): Promise<void> {
  const question = await deleteQuestion(parseQuestionId(req.params.questionId));

  res.status(200).json({
    success: true,
    data: question,
  });
}
