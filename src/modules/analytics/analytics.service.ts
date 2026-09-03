import { TEST_SERIES_TYPES } from '../../database/models/enums';
import { analyticsRepository } from '../../database/repositories/analytics.repository';

const OVERVIEW_WINDOW_DAYS = 30;
const EXPIRING_SOON_DAYS = 7;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatUtcBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildDailyBuckets(since: Date, dayCount: number): string[] {
  const buckets: string[] = [];
  for (let i = 0; i < dayCount; i += 1) {
    buckets.push(formatUtcBucket(addUtcDays(since, i)));
  }
  return buckets;
}

function fillAttemptsByTypeOverTime(
  buckets: string[],
  rows: Array<{ bucket: string; type: (typeof TEST_SERIES_TYPES)[number]; count: number }>,
) {
  const byBucket = new Map(
    buckets.map((bucket) => [
      bucket,
      {
        bucket,
        MCQ: 0,
        PDF: 0,
        EDITOR: 0,
      },
    ]),
  );

  for (const row of rows) {
    const entry = byBucket.get(row.bucket);
    if (!entry || !TEST_SERIES_TYPES.includes(row.type)) continue;
    entry[row.type] = row.count;
  }

  return buckets.map((bucket) => byBucket.get(bucket)!);
}

function fillRevenueOverTime(
  buckets: string[],
  rows: Array<{ bucket: string; amountPaise: number }>,
) {
  const byBucket = new Map(rows.map((row) => [row.bucket, row.amountPaise]));
  return buckets.map((bucket) => ({
    bucket,
    amountPaise: byBucket.get(bucket) ?? 0,
  }));
}

export async function getAdminAnalyticsOverview() {
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const until = addUtcDays(todayStart, 1);
  const since = addUtcDays(until, -OVERVIEW_WINDOW_DAYS);
  const buckets = buildDailyBuckets(since, OVERVIEW_WINDOW_DAYS);
  const expiringUntil = addUtcDays(now, EXPIRING_SOON_DAYS);

  const [
    activeStudents,
    paidRevenuePaise,
    activeEntitlements,
    attemptsInFlight,
    evalBacklog,
    evaluationQueue,
    purchasesByStatus,
    catalogByType,
    attemptsByTypeRows,
    revenueRows,
    entitlementsExpiringIn7Days,
    resultsByStatus,
    attemptsByNumber,
  ] = await Promise.all([
    analyticsRepository.countActiveStudents(),
    analyticsRepository.sumPaidRevenuePaise(),
    analyticsRepository.countActiveEntitlements(),
    analyticsRepository.countAttemptsInFlight(),
    analyticsRepository.countEvalBacklog(),
    analyticsRepository.groupEvaluationsByStatus(),
    analyticsRepository.groupPurchasesByStatus(),
    analyticsRepository.groupActiveCatalogByType(),
    analyticsRepository.attemptsByTypeOverTime(since, until),
    analyticsRepository.revenueOverTime(since, until),
    analyticsRepository.countEntitlementsExpiringBetween(now, expiringUntil),
    analyticsRepository.groupResultsByStatus(),
    analyticsRepository.groupAttemptsByNumber(),
  ]);

  return {
    windowDays: OVERVIEW_WINDOW_DAYS,
    kpis: {
      activeStudents,
      paidRevenuePaise,
      activeEntitlements,
      attemptsInFlight,
      evalBacklog,
    },
    evaluationQueue,
    purchasesByStatus,
    catalogByType,
    attemptsByTypeOverTime: fillAttemptsByTypeOverTime(buckets, attemptsByTypeRows),
    revenueOverTime: fillRevenueOverTime(buckets, revenueRows),
    secondary: {
      entitlementsExpiringIn7Days,
      resultsPending: resultsByStatus.PENDING,
      resultsPublished: resultsByStatus.PUBLISHED,
      attemptsByNumber,
    },
  };
}
