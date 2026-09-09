import type { ClientSession } from 'mongoose';

import { remapDuplicateKey } from '../../database/errors';
import type { UserRole } from '../../database/models/enums';
import {
  auditLogRepository,
  authSessionRepository,
  userRepository,
} from '../../database/repositories/index';
import { withTransaction } from '../../database/transactions';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { hashPassword } from '../auth/password';
import { isMobileNumberDuplicate, mobileAlreadyRegistered } from '../auth/mobile-number';
import { toAdminUserDto } from './user.dto';
import type {
  AdminUserListQuery,
  CreateAdminUserInput,
  UpdateAdminUserInput,
} from './user.validation';

export type AdminActor = {
  userId: string;
  role: UserRole;
};

function userNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.USER_NOT_FOUND,
    message: 'User not found.',
  });
}

function emailAlreadyRegistered(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
    message: 'An account with this email already exists.',
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
      resource: { type: 'User', id: resourceId },
      metadata,
    },
    session ? { session } : undefined,
  );
}

async function requireUser(userId: string, session?: ClientSession) {
  const user = await userRepository.findById(userId, session ? { session } : undefined);

  if (!user || user.deletedAt != null) {
    throw userNotFound();
  }

  return user;
}

export async function listAdminUsers(
  query: AdminUserListQuery,
  pagination: PaginationInput,
) {
  const filter = {
    ...(query.ids ? { ids: query.ids } : {}),
    ...(query.role ? { role: query.role } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search ? { textContains: query.search } : {}),
  };
  const [items, total] = await Promise.all([
    userRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { createdAt: -1 },
    }),
    userRepository.count(filter),
  ]);

  return {
    items: items.map(toAdminUserDto),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getAdminUser(userId: string) {
  const user = await requireUser(userId);
  return toAdminUserDto(user);
}

function remapUserUniqueConflict(error: unknown): never {
  if (isMobileNumberDuplicate(error)) {
    remapDuplicateKey(error, mobileAlreadyRegistered());
  }

  remapDuplicateKey(error, emailAlreadyRegistered());
}

export async function createAdminUser(actor: AdminActor, input: CreateAdminUserInput) {
  const existing = await userRepository.findByEmail(input.email);

  if (existing) {
    throw emailAlreadyRegistered();
  }

  const existingMobile = await userRepository.findByMobileNumber(input.mobileNumber);

  if (existingMobile) {
    throw mobileAlreadyRegistered();
  }

  const passwordHash = await hashPassword(input.password);

  try {
    return await withTransaction(async (session) => {
      const created = await userRepository.create(
        {
          email: input.email,
          passwordHash,
          role: input.role,
          status: 'ACTIVE',
          name: input.name,
          mobileNumber: input.mobileNumber,
        },
        { session },
      );

      await writeAudit(
        actor,
        'USER_CREATED',
        created._id.toString(),
        { role: created.role, email: created.email },
        session,
      );

      return toAdminUserDto(created);
    });
  } catch (error) {
    remapUserUniqueConflict(error);
  }
}

export async function updateAdminUser(
  actor: AdminActor,
  userId: string,
  input: UpdateAdminUserInput,
) {
  const user = await requireUser(userId);
  const updates: {
    role?: typeof user.role;
    status?: typeof user.status;
    mobileNumber?: string;
  } = {};

  if (input.role !== undefined && input.role !== user.role) {
    updates.role = input.role;
  }

  if (input.status !== undefined && input.status !== user.status) {
    updates.status = input.status;
  }

  if (input.mobileNumber !== undefined && input.mobileNumber !== user.mobileNumber) {
    const existingMobile = await userRepository.findByMobileNumber(input.mobileNumber);

    if (existingMobile && existingMobile._id.toString() !== userId) {
      throw mobileAlreadyRegistered();
    }

    updates.mobileNumber = input.mobileNumber;
  }

  if (Object.keys(updates).length === 0) {
    return toAdminUserDto(user);
  }

  const shouldRevokeSessions = updates.role !== undefined || updates.status !== undefined;

  try {
    const updated = await withTransaction(async (session) => {
      const next = await userRepository.updateById(userId, { $set: updates }, { session });

      if (!next || next.deletedAt != null) {
        throw userNotFound();
      }

      if (shouldRevokeSessions) {
        await authSessionRepository.revokeAllForUser(userId, new Date(), { session });
      }

      if (updates.role) {
        await writeAudit(
          actor,
          'ROLE_CHANGED',
          userId,
          { previousRole: user.role, role: updates.role },
          session,
        );
      }

      if (updates.status === 'DISABLED') {
        await writeAudit(
          actor,
          'USER_DISABLED',
          userId,
          { previousStatus: user.status, status: updates.status },
          session,
        );
      }

      if (updates.status === 'ACTIVE') {
        await writeAudit(
          actor,
          'USER_ENABLED',
          userId,
          { previousStatus: user.status, status: updates.status },
          session,
        );
      }

      if (updates.mobileNumber) {
        await writeAudit(
          actor,
          'USER_MOBILE_NUMBER_CHANGED',
          userId,
          { previousMobileNumber: user.mobileNumber ?? null, mobileNumber: updates.mobileNumber },
          session,
        );
      }

      return next;
    });

    return toAdminUserDto(updated);
  } catch (error) {
    remapUserUniqueConflict(error);
  }
}
