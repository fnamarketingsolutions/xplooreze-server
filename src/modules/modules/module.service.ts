import { remapDuplicateKey } from '../../database/errors';
import { categoryRepository, moduleRepository } from '../../database/repositories/index';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { requireExistingCategory, requireVisibleCategory } from '../categories/category.service';
import { toAdminModuleDto, toModuleDto } from './module.dto';
import type {
  AdminModuleListQuery,
  CatalogModuleListQuery,
  CreateModuleInput,
  UpdateModuleInput,
} from './module.validation';

function moduleNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.MODULE_NOT_FOUND,
    message: 'Module not found.',
  });
}

function moduleNameConflict(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.MODULE_NAME_CONFLICT,
    message: 'An active module with this name already exists in the category.',
  });
}

function isVisible(module: { status: string; deletedAt?: Date | null }): boolean {
  return module.deletedAt == null && module.status === 'ACTIVE';
}

export async function listVisibleModules(
  query: CatalogModuleListQuery,
  pagination: PaginationInput,
) {
  if (query.categoryId) {
    await requireVisibleCategory(query.categoryId);
  }

  const filter = query.categoryId
    ? { status: 'ACTIVE' as const, categoryId: query.categoryId }
    : {
        status: 'ACTIVE' as const,
        categoryId: {
          $in: (await categoryRepository.list({ status: 'ACTIVE' })).map(
            (category) => category._id,
          ),
        },
      };

  const [items, total] = await Promise.all([
    moduleRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { name: 1 },
    }),
    moduleRepository.count(filter),
  ]);

  return {
    items: items.map(toModuleDto),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getVisibleModule(moduleId: string) {
  const module = await moduleRepository.findById(moduleId);

  if (!module || !isVisible(module)) {
    throw moduleNotFound();
  }

  await requireVisibleCategory(module.categoryId.toString());

  return toModuleDto(module);
}

export async function listAdminModules(query: AdminModuleListQuery, pagination: PaginationInput) {
  if (query.categoryId) {
    await requireExistingCategory(query.categoryId);
  }

  const filter = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
  };

  const [items, total] = await Promise.all([
    moduleRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { name: 1 },
    }),
    moduleRepository.count(filter),
  ]);

  return {
    items: items.map(toAdminModuleDto),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getAdminModule(moduleId: string) {
  const module = await moduleRepository.findById(moduleId);

  if (!module || module.deletedAt != null) {
    throw moduleNotFound();
  }

  return toAdminModuleDto(module);
}

export async function createModule(input: CreateModuleInput) {
  await requireExistingCategory(input.categoryId);

  try {
    const created = await moduleRepository.create({
      categoryId: input.categoryId,
      name: input.name,
      description: input.description,
      status: input.status,
    });
    return toAdminModuleDto(created);
  } catch (error) {
    remapDuplicateKey(error, moduleNameConflict());
  }
}

export async function updateModule(moduleId: string, input: UpdateModuleInput) {
  const existing = await moduleRepository.findById(moduleId);

  if (!existing || existing.deletedAt != null) {
    throw moduleNotFound();
  }

  try {
    const updated = await moduleRepository.updateById(moduleId, { $set: input });

    if (!updated || updated.deletedAt != null) {
      throw moduleNotFound();
    }

    return toAdminModuleDto(updated);
  } catch (error) {
    remapDuplicateKey(error, moduleNameConflict());
  }
}

export async function deleteModule(moduleId: string) {
  const existing = await moduleRepository.findById(moduleId);

  if (!existing || existing.deletedAt != null) {
    throw moduleNotFound();
  }

  const deleted = await moduleRepository.softDeleteById(moduleId, new Date());

  if (!deleted) {
    throw moduleNotFound();
  }

  return toAdminModuleDto(deleted);
}

export async function requireExistingModule(moduleId: string) {
  const module = await moduleRepository.findById(moduleId);

  if (!module || module.deletedAt != null) {
    throw moduleNotFound();
  }

  return module;
}

export async function requireVisibleModule(moduleId: string) {
  const module = await moduleRepository.findById(moduleId);

  if (!module || !isVisible(module)) {
    throw moduleNotFound();
  }

  await requireVisibleCategory(module.categoryId.toString());

  return module;
}
