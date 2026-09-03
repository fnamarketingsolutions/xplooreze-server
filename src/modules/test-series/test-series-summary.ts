import type { TestSeriesType } from '../../database/models/enums';
import {
  categoryRepository,
  moduleRepository,
  testSeriesRepository,
} from '../../database/repositories/index';

export type TestSeriesSummaryDto = {
  id: string;
  title: string;
  type: TestSeriesType;
  moduleName: string | null;
  categoryId: string | null;
  categoryName: string | null;
};

export async function buildTestSeriesSummaryByIds(
  testSeriesIds: string[],
): Promise<Map<string, TestSeriesSummaryDto>> {
  const uniqueIds = [...new Set(testSeriesIds.filter(Boolean))];

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const seriesList = await testSeriesRepository.findByIds(uniqueIds);
  const moduleIds = [
    ...new Set(
      seriesList
        .map((series) => series.moduleId?.toString())
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const modules = moduleIds.length > 0 ? await moduleRepository.findByIds(moduleIds) : [];
  const categoryIds = [
    ...new Set(
      modules
        .map((moduleDoc) => moduleDoc.categoryId?.toString())
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const categories =
    categoryIds.length > 0 ? await categoryRepository.findByIds(categoryIds) : [];

  const categoryNameById = new Map(
    categories.map((category) => [category._id.toString(), category.name as string]),
  );
  const moduleById = new Map(
    modules.map((moduleDoc) => [
      moduleDoc._id.toString(),
      {
        name: moduleDoc.name as string,
        categoryId: moduleDoc.categoryId.toString(),
        categoryName: categoryNameById.get(moduleDoc.categoryId.toString()) ?? null,
      },
    ]),
  );

  const summaryById = new Map<string, TestSeriesSummaryDto>();
  for (const series of seriesList) {
    const moduleId = series.moduleId?.toString();
    const moduleInfo = moduleId ? moduleById.get(moduleId) : undefined;
    summaryById.set(series._id.toString(), {
      id: series._id.toString(),
      title: series.title,
      type: series.type as TestSeriesType,
      moduleName: moduleInfo?.name ?? null,
      categoryId: moduleInfo?.categoryId ?? null,
      categoryName: moduleInfo?.categoryName ?? null,
    });
  }

  return summaryById;
}
