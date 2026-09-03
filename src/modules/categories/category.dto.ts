import type { CatalogStatus } from '../../database/models/enums';

export type CategoryDto = {
  id: string;
  name: string;
  description: string;
  status: CatalogStatus;
};

export type AdminCategoryDto = CategoryDto & {
  createdAt: string;
  updatedAt: string;
};

type CategoryLike = {
  _id: { toString(): string };
  name: string;
  description?: string;
  status: CatalogStatus;
  createdAt: Date;
  updatedAt: Date;
};

export function toCategoryDto(category: CategoryLike): CategoryDto {
  return {
    id: category._id.toString(),
    name: category.name,
    description: category.description ?? '',
    status: category.status,
  };
}

export function toAdminCategoryDto(category: CategoryLike): AdminCategoryDto {
  return {
    ...toCategoryDto(category),
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}
