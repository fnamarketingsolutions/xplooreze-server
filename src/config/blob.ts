import { isVercelRuntime } from '../shared/runtime/vercel';
import { optionalString } from './env-helpers';

const DEFAULT_UPLOAD_URL_TTL_SECONDS = 300;
const DEFAULT_DOWNLOAD_URL_TTL_SECONDS = 60;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export type BlobAccess = 'public' | 'private';

export type BlobConfig = {
  readWriteToken?: string;
  storeId?: string;
  oidcToken?: string;
  access?: BlobAccess;
  uploadUrlTtlSeconds?: number;
  downloadUrlTtlSeconds?: number;
  cleanupEnabled: boolean;
  cleanupIntervalMs: number;
};

export type RequiredBlobConfig = {
  readWriteToken?: string;
  storeId?: string;
  oidcToken?: string;
  access: BlobAccess;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
};

function parsePositiveTtlSeconds(
  value: string | undefined,
  envName: string,
  fallback: number,
): number {
  const raw = optionalString(value);

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${envName}. Expected a positive integer number of seconds.`);
  }

  return parsed;
}

function parseBlobAccess(value: string | undefined): BlobAccess {
  const raw = optionalString(value);

  if (!raw) {
    return 'private';
  }

  if (raw === 'public' || raw === 'private') {
    return raw;
  }

  throw new Error('Invalid BLOB_ACCESS. Expected public or private.');
}

function parseCleanupEnabled(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = optionalString(value)?.toLowerCase();

  if (!raw) {
    // In-process intervals do not run reliably on Vercel; default off there.
    return !isVercelRuntime(env);
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new Error('Invalid BLOB_CLEANUP_ENABLED. Expected true or false.');
}

function parseCleanupIntervalMs(value: string | undefined): number {
  const raw = optionalString(value);

  if (!raw) {
    return DEFAULT_CLEANUP_INTERVAL_MS;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('Invalid BLOB_CLEANUP_INTERVAL_MS. Expected a positive integer number of milliseconds.');
  }

  return parsed;
}

export function loadBlobConfig(env: NodeJS.ProcessEnv = process.env): BlobConfig {
  return {
    readWriteToken: optionalString(env.BLOB_READ_WRITE_TOKEN),
    storeId: optionalString(env.BLOB_STORE_ID),
    oidcToken: optionalString(env.VERCEL_OIDC_TOKEN),
    access: parseBlobAccess(env.BLOB_ACCESS),
    uploadUrlTtlSeconds: parsePositiveTtlSeconds(
      env.BLOB_UPLOAD_URL_TTL_SECONDS,
      'BLOB_UPLOAD_URL_TTL_SECONDS',
      DEFAULT_UPLOAD_URL_TTL_SECONDS,
    ),
    downloadUrlTtlSeconds: parsePositiveTtlSeconds(
      env.BLOB_DOWNLOAD_URL_TTL_SECONDS,
      'BLOB_DOWNLOAD_URL_TTL_SECONDS',
      DEFAULT_DOWNLOAD_URL_TTL_SECONDS,
    ),
    cleanupEnabled: parseCleanupEnabled(env.BLOB_CLEANUP_ENABLED, env),
    cleanupIntervalMs: parseCleanupIntervalMs(env.BLOB_CLEANUP_INTERVAL_MS),
  };
}

export function requireBlobConfig(config: BlobConfig): RequiredBlobConfig {
  const hasReadWriteToken = config.readWriteToken !== undefined && config.readWriteToken.length > 0;
  const hasStoreId = config.storeId !== undefined && config.storeId.length > 0;
  const hasOidcToken = config.oidcToken !== undefined && config.oidcToken.length > 0;

  if (!hasReadWriteToken && !(hasStoreId && hasOidcToken)) {
    throw new Error(
      'Invalid Blob configuration: set BLOB_READ_WRITE_TOKEN or both BLOB_STORE_ID and VERCEL_OIDC_TOKEN',
    );
  }

  return {
    ...(hasReadWriteToken ? { readWriteToken: config.readWriteToken } : {}),
    ...(hasStoreId ? { storeId: config.storeId } : {}),
    ...(hasOidcToken ? { oidcToken: config.oidcToken } : {}),
    access: config.access ?? 'private',
    uploadUrlTtlSeconds: config.uploadUrlTtlSeconds ?? DEFAULT_UPLOAD_URL_TTL_SECONDS,
    downloadUrlTtlSeconds: config.downloadUrlTtlSeconds ?? DEFAULT_DOWNLOAD_URL_TTL_SECONDS,
  };
}
