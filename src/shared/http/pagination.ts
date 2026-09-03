import { readQueryValue, validationError } from '../validation/http';

export const PAGINATION_DEFAULT_PAGE = 1;
export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

export type PaginationInput = {
  page: number;
  limit: number;
  skip: number;
};

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export function parsePagination(query: object): PaginationInput {
  const record = query as Record<string, unknown>;
  const page = parsePositiveInteger(
    readQueryValue(record, 'page'),
    'page',
    PAGINATION_DEFAULT_PAGE,
  );
  const limit = parsePositiveInteger(
    readQueryValue(record, 'limit'),
    'limit',
    PAGINATION_DEFAULT_LIMIT,
  );

  if (limit > PAGINATION_MAX_LIMIT) {
    throw validationError({
      limit: `Must be at most ${PAGINATION_MAX_LIMIT}.`,
    });
  }

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

export function toPaginationMeta(input: PaginationInput, total: number): PaginationMeta {
  return {
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.ceil(total / input.limit),
  };
}

function parsePositiveInteger(raw: string | undefined, field: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  if (!/^[0-9]+$/.test(raw)) {
    throw validationError({ [field]: 'Must be a positive integer.' });
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw validationError({ [field]: 'Must be a positive integer.' });
  }

  return value;
}
