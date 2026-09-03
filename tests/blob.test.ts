import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, resetConfigForTests } from '../src/config/index';
import { requireBlobConfig } from '../src/config/blob';

describe('Blob configuration infrastructure', () => {
  afterEach(() => {
    resetConfigForTests();
  });

  it('accepts a read-write token configuration without network calls', () => {
    const config = requireBlobConfig({
      readWriteToken: 'vercel_blob_rw_test',
      uploadUrlTtlSeconds: 120,
      downloadUrlTtlSeconds: 45,
    });

    expect(config).toEqual({
      readWriteToken: 'vercel_blob_rw_test',
      access: 'private',
      uploadUrlTtlSeconds: 120,
      downloadUrlTtlSeconds: 45,
    });
  });

  it('loads a singleton-friendly Blob config from process configuration', () => {
    const loaded = loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test',
    });

    expect(loaded.blob.readWriteToken).toBe('vercel_blob_rw_test');
    expect(loaded.blob.access).toBe('private');
    expect(loaded.blob.uploadUrlTtlSeconds).toBe(300);
    expect(loaded.blob.downloadUrlTtlSeconds).toBe(60);
  });

  it('fails initialization when no supported Blob credentials are configured', () => {
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    expect(() => requireBlobConfig(loadConfig().blob)).toThrow(
      'Invalid Blob configuration: set BLOB_READ_WRITE_TOKEN or both BLOB_STORE_ID and VERCEL_OIDC_TOKEN',
    );
  });
});
