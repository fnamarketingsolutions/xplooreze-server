import type { Request, Response } from 'express';

import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { parsePagination } from '../../shared/http/pagination';
import { createAdminUser, getAdminUser, listAdminUsers, updateAdminUser } from './user.service';
import {
  parseAdminUserListQuery,
  parseCreateAdminUserInput,
  parseUpdateAdminUserInput,
  parseUserId,
} from './user.validation';

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

export async function listAdminUsersController(req: Request, res: Response): Promise<void> {
  const result = await listAdminUsers(
    parseAdminUserListQuery(req.query),
    parsePagination(req.query),
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
}

export async function getAdminUserController(req: Request, res: Response): Promise<void> {
  const user = await getAdminUser(parseUserId(req.params.userId));

  res.status(200).json({
    success: true,
    data: user,
  });
}

export async function createAdminUserController(req: Request, res: Response): Promise<void> {
  const user = await createAdminUser(requireAdminActor(req), parseCreateAdminUserInput(req.body));

  res.status(201).json({
    success: true,
    data: user,
  });
}

export async function updateAdminUserController(req: Request, res: Response): Promise<void> {
  const user = await updateAdminUser(
    requireAdminActor(req),
    parseUserId(req.params.userId),
    parseUpdateAdminUserInput(req.body),
  );

  res.status(200).json({
    success: true,
    data: user,
  });
}
