import type { CatalogStatus } from '../../database/models/enums';

export type ModuleDto = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  status: CatalogStatus;
};

export type AdminModuleDto = ModuleDto & {
  createdAt: string;
  updatedAt: string;
};

type ModuleLike = {
  _id: { toString(): string };
  categoryId: { toString(): string };
  name: string;
  description?: string;
  status: CatalogStatus;
  createdAt: Date;
  updatedAt: Date;
};

export function toModuleDto(module: ModuleLike): ModuleDto {
  return {
    id: module._id.toString(),
    categoryId: module.categoryId.toString(),
    name: module.name,
    description: module.description ?? '',
    status: module.status,
  };
}

export function toAdminModuleDto(module: ModuleLike): AdminModuleDto {
  return {
    ...toModuleDto(module),
    createdAt: module.createdAt.toISOString(),
    updatedAt: module.updatedAt.toISOString(),
  };
}
