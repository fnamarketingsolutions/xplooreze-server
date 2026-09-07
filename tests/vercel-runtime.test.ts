import { describe, expect, it } from 'vitest';

import { loadJobsConfig } from '../src/config/jobs';
import { isVercelRuntime } from '../src/shared/runtime/vercel';

describe('isVercelRuntime', () => {
  it('detects VERCEL=1 and true', () => {
    expect(isVercelRuntime({ VERCEL: '1' })).toBe(true);
    expect(isVercelRuntime({ VERCEL: 'true' })).toBe(true);
    expect(isVercelRuntime({})).toBe(false);
    expect(isVercelRuntime({ VERCEL: '0' })).toBe(false);
  });
});

describe('jobs config on Vercel', () => {
  it('defaults purchase cleanup off when VERCEL=1', () => {
    expect(loadJobsConfig({}).purchaseCleanupEnabled).toBe(true);
    expect(loadJobsConfig({ VERCEL: '1' }).purchaseCleanupEnabled).toBe(false);
    expect(
      loadJobsConfig({ VERCEL: '1', PURCHASE_CLEANUP_ENABLED: 'true' }).purchaseCleanupEnabled,
    ).toBe(true);
  });
});
