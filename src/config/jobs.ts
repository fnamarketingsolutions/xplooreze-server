import { optionalString } from './env-helpers';

const DEFAULT_PURCHASE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export type JobsConfig = {
  purchaseCleanupEnabled: boolean;
  purchaseCleanupIntervalMs: number;
};

function parseCleanupEnabled(value: string | undefined): boolean {
  const raw = optionalString(value)?.toLowerCase();

  if (!raw) {
    return true;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new Error('Invalid PURCHASE_CLEANUP_ENABLED. Expected true or false.');
}

function parseCleanupIntervalMs(value: string | undefined): number {
  const raw = optionalString(value);

  if (!raw) {
    return DEFAULT_PURCHASE_CLEANUP_INTERVAL_MS;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      'Invalid PURCHASE_CLEANUP_INTERVAL_MS. Expected a positive integer number of milliseconds.',
    );
  }

  return parsed;
}

export function loadJobsConfig(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  return {
    purchaseCleanupEnabled: parseCleanupEnabled(env.PURCHASE_CLEANUP_ENABLED),
    purchaseCleanupIntervalMs: parseCleanupIntervalMs(env.PURCHASE_CLEANUP_INTERVAL_MS),
  };
}
