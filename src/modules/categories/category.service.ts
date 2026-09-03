import { remapDuplicateKey } from '../../database/errors';
import { categoryRepository } from '../../database/repositories/index';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { toAdminCategoryDto, toCategoryDto } from './category.dto';
import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  UpdateCategoryInput,
} from './category.validation';

function categoryNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.CATEGORY_NOT_FOUND,
    message: 'Category not found.',
  });
}

function categoryNameConflict(): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCodes.CATEGORY_NAME_CONFLICT,
    message: 'An active category with this name already exists.',
  });
}

function isVisible(category: { status: string; deletedAt?: Date | null }): boolean {
  return category.deletedAt == null && category.status === 'ACTIVE';
}

export async function listVisibleCategories(pagination: PaginationInput) {
  const filter = { status: 'ACTIVE' as const };
  const [items, total] = await Promise.all([
    categoryRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { name: 1 },
    }),
    categoryRepository.count(filter),
  ]);

  return {
    items: items.map(toCategoryDto),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getVisibleCategory(categoryId: string) {
  const category = await categoryRepository.findById(categoryId);

  if (!category || !isVisible(category)) {
    throw categoryNotFound();
  }

  return toCategoryDto(category);
}

export async function listAdminCategories(query: ListCategoriesQuery, pagination: PaginationInput) {
  const filter = query.status ? { status: query.status } : {};
  const [items, total] = await Promise.all([
    categoryRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { name: 1 },
    }),
    categoryRepository.count(filter),
  ]);

  return {
    items: items.map(toAdminCategoryDto),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getAdminCategory(categoryId: string) {
  const category = await categoryRepository.findById(categoryId);

  if (!category || category.deletedAt != null) {
    throw categoryNotFound();
  }

  return toAdminCategoryDto(category);
}

export async function createCategory(input: CreateCategoryInput) {
  try {
    const created = await categoryRepository.create({
      name: input.name,
      description: input.description,
      status: input.status,
    });
    return toAdminCategoryDto(created);
  } catch (error) {
    remapDuplicateKey(error, categoryNameConflict());
  }
}

export async function updateCategory(categoryId: string, input: UpdateCategoryInput) {
  const existing = await categoryRepository.findById(categoryId);

  if (!existing || existing.deletedAt != null) {
    throw categoryNotFound();
  }

  try {
    const updated = await categoryRepository.updateById(categoryId, { $set: input });

    if (!updated || updated.deletedAt != null) {
      throw categoryNotFound();
    }

    return toAdminCategoryDto(updated);
  } catch (error) {
    remapDuplicateKey(error, categoryNameConflict());
  }
}

export async function deleteCategory(categoryId: string) {
  const existing = await categoryRepository.findById(categoryId);

  if (!existing || existing.deletedAt != null) {
    throw categoryNotFound();
  }

  const deleted = await categoryRepository.softDeleteById(categoryId, new Date());

  if (!deleted) {
    throw categoryNotFound();
  }

  return toAdminCategoryDto(deleted);
}

export async function requireExistingCategory(categoryId: string) {
  const category = await categoryRepository.findById(categoryId);

  if (!category || category.deletedAt != null) {
    throw categoryNotFound();
  }

  return category;
}

export async function requireVisibleCategory(categoryId: string) {
  const category = await categoryRepository.findById(categoryId);

  if (!category || !isVisible(category)) {
    throw categoryNotFound();
  }

  return category;
}
