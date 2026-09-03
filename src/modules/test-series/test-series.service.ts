import { DEFAULT_MAX_SCORE, V1_MAX_ATTEMPTS, isUnlimitedAttemptPath } from '../../database/models/conventions';
import {
  categoryRepository,
  moduleRepository,
  testSeriesRepository,
} from '../../database/repositories/index';
import type { PaginationInput } from '../../shared/http/pagination';
import { toPaginationMeta } from '../../shared/http/pagination';
import { AppError, ErrorCodes } from '../../shared/errors/app-error';
import { requireExistingCategory, requireVisibleCategory } from '../categories/category.service';
import { requireExistingModule, requireVisibleModule } from '../modules/module.service';
import { toAdminTestSeriesDto, toTestSeriesDto } from './test-series.dto';
import type {
  AdminTestSeriesListQuery,
  CatalogTestSeriesListQuery,
  CreateTestSeriesInput,
  ScoringPatch,
  UpdateTestSeriesInput,
} from './test-series.validation';
import { resolveAccess } from './test-series.validation';

function testSeriesNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.TEST_SERIES_NOT_FOUND,
    message: 'Test series not found.',
  });
}

function isVisible(testSeries: { status: string; deletedAt?: Date | null }): boolean {
  return testSeries.deletedAt == null && testSeries.status === 'ACTIVE';
}

async function visibleModuleIds(query: { categoryId?: string; moduleId?: string }) {
  if (query.moduleId) {
    const module = await requireVisibleModule(query.moduleId);

    if (query.categoryId && module.categoryId.toString() !== query.categoryId) {
      return [];
    }

    return [module._id];
  }

  if (query.categoryId) {
    await requireVisibleCategory(query.categoryId);
  }

  const modules = await moduleRepository.list({
    status: 'ACTIVE',
    ...(query.categoryId
      ? { categoryId: query.categoryId }
      : {
          categoryId: {
            $in: (await categoryRepository.list({ status: 'ACTIVE' })).map(
              (category) => category._id,
            ),
          },
        }),
  });

  return modules.map((module) => module._id);
}

async function adminModuleIds(query: { categoryId?: string; moduleId?: string }) {
  if (query.moduleId) {
    const module = await requireExistingModule(query.moduleId);

    if (query.categoryId && module.categoryId.toString() !== query.categoryId) {
      return [];
    }

    return [module._id];
  }

  if (query.categoryId) {
    await requireExistingCategory(query.categoryId);
    const modules = await moduleRepository.list({ categoryId: query.categoryId });
    return modules.map((module) => module._id);
  }

  return undefined;
}

export async function listVisibleTestSeries(
  query: CatalogTestSeriesListQuery,
  pagination: PaginationInput,
) {
  const moduleIds = await visibleModuleIds(query);
  const filter = {
    status: 'ACTIVE' as const,
    moduleId: { $in: moduleIds },
    ...(query.type ? { type: query.type } : {}),
    ...(query.search ? { titleContains: query.search } : {}),
  };

  const [items, total] = await Promise.all([
    testSeriesRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { title: 1 },
    }),
    testSeriesRepository.count(filter),
  ]);

  return {
    items: items.map((item) => toTestSeriesDto(item)),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getVisibleTestSeries(testSeriesId: string) {
  const testSeries = await testSeriesRepository.findById(testSeriesId);

  if (!testSeries || !isVisible(testSeries)) {
    throw testSeriesNotFound();
  }

  await requireVisibleModule(testSeries.moduleId.toString());

  return toTestSeriesDto(testSeries);
}

export async function listAdminTestSeries(
  query: AdminTestSeriesListQuery,
  pagination: PaginationInput,
) {
  const moduleIds = await adminModuleIds(query);
  const filter = {
    ...(query.status ? { status: query.status } : {}),
    ...(moduleIds ? { moduleId: { $in: moduleIds } } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.search ? { titleContains: query.search } : {}),
    ...(query.ids ? { ids: query.ids } : {}),
  };

  const [items, total] = await Promise.all([
    testSeriesRepository.list(filter, {
      skip: pagination.skip,
      limit: pagination.limit,
      sort: { title: 1 },
    }),
    testSeriesRepository.count(filter),
  ]);

  return {
    items: items.map((item) => toAdminTestSeriesDto(item)),
    pagination: toPaginationMeta(pagination, total),
  };
}

export async function getAdminTestSeries(testSeriesId: string) {
  const testSeries = await testSeriesRepository.findById(testSeriesId);

  if (!testSeries || testSeries.deletedAt != null) {
    throw testSeriesNotFound();
  }

  return toAdminTestSeriesDto(testSeries);
}

export async function createTestSeries(input: CreateTestSeriesInput) {
  await requireExistingModule(input.moduleId);

  const created = await testSeriesRepository.create({
    moduleId: input.moduleId,
    title: input.title,
    description: input.description,
    type: input.type,
    duration: input.duration,
    access: input.access,
    availability: input.availability,
    attemptPolicy: {
      maxAttempts: isUnlimitedAttemptPath({ type: input.type, access: input.access })
        ? null
        : V1_MAX_ATTEMPTS,
    },
    scoring: persistScoring(input.type, input.scoring),
    status: input.status,
  });

  return toAdminTestSeriesDto(created);
}

function scoringValidationError(message: string): AppError {
  return new AppError({
    statusCode: 400,
    code: ErrorCodes.VALIDATION_ERROR,
    message: 'Request validation failed.',
    details: { fields: { scoring: message } },
  });
}

function persistScoring(type: string, scoring: CreateTestSeriesInput['scoring']) {
  if (type === 'MCQ') {
    return {
      correctMarks: scoring.correctMarks,
      incorrectMarks: scoring.incorrectMarks,
      unansweredMarks: scoring.unansweredMarks,
      maxScore: scoring.maxScore,
    };
  }

  return { maxScore: scoring.maxScore };
}

function mergeScoring(
  existing: {
    type: string;
    scoring?: {
      correctMarks?: number;
      incorrectMarks?: number;
      unansweredMarks?: number;
      maxScore?: number;
    };
  },
  patch: ScoringPatch,
) {
  const hasMcqMarks =
    patch.correctMarks !== undefined ||
    patch.incorrectMarks !== undefined ||
    patch.unansweredMarks !== undefined;

  if (existing.type !== 'MCQ') {
    if (hasMcqMarks) {
      throw scoringValidationError('MCQ mark fields are only applicable to MCQ test series.');
    }

    if (patch.maxScore === undefined) {
      throw scoringValidationError('maxScore is required.');
    }

    return { maxScore: patch.maxScore };
  }

  if (hasMcqMarks) {
    if (
      patch.correctMarks === undefined ||
      patch.incorrectMarks === undefined ||
      patch.unansweredMarks === undefined
    ) {
      throw scoringValidationError('MCQ test series require scoring configuration.');
    }
  }

  const correctMarks = patch.correctMarks ?? existing.scoring?.correctMarks;
  const incorrectMarks = patch.incorrectMarks ?? existing.scoring?.incorrectMarks;
  const unansweredMarks = patch.unansweredMarks ?? existing.scoring?.unansweredMarks;

  if (correctMarks === undefined || incorrectMarks === undefined || unansweredMarks === undefined) {
    throw scoringValidationError('MCQ test series require scoring configuration.');
  }

  return {
    correctMarks,
    incorrectMarks,
    unansweredMarks,
    maxScore: patch.maxScore ?? existing.scoring?.maxScore ?? DEFAULT_MAX_SCORE,
  };
}

export async function updateTestSeries(testSeriesId: string, input: UpdateTestSeriesInput) {
  const existing = await testSeriesRepository.findById(testSeriesId);

  if (!existing || existing.deletedAt != null) {
    throw testSeriesNotFound();
  }

  const update: Record<string, unknown> = {};

  if (input.title !== undefined) {
    update.title = input.title;
  }

  if (input.description !== undefined) {
    update.description = input.description;
  }

  if (input.duration !== undefined) {
    update.duration = input.duration;
  }

  if (input.availability !== undefined) {
    update.availability = input.availability;
  }

  if (input.status !== undefined) {
    update.status = input.status;
  }

  if (input.access !== undefined) {
    update.access = resolveAccess(existing.type, input.access);
  }

  if (input.scoring !== undefined) {
    update.scoring = mergeScoring(existing, input.scoring);
  }

  const updated = await testSeriesRepository.updateById(testSeriesId, { $set: update });

  if (!updated || updated.deletedAt != null) {
    throw testSeriesNotFound();
  }

  return toAdminTestSeriesDto(updated);
}

export async function deleteTestSeries(testSeriesId: string) {
  const existing = await testSeriesRepository.findById(testSeriesId);

  if (!existing || existing.deletedAt != null) {
    throw testSeriesNotFound();
  }

  const deleted = await testSeriesRepository.softDeleteById(testSeriesId, new Date());

  if (!deleted) {
    throw testSeriesNotFound();
  }

  return toAdminTestSeriesDto(deleted);
}
