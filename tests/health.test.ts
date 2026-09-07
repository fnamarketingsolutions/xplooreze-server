import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { resetLoggerForTests } from '../src/shared/logger/logger';

describe('GET /health', () => {
  beforeEach(() => {
    resetConfigForTests();
    resetLoggerForTests();
    loadConfig();
  });

  it('returns a successful liveness response without external dependencies', async () => {
    const app = createApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        status: 'ok',
      },
    });
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('preserves an incoming request id', async () => {
    const app = createApp();
    const requestId = '11111111-2222-4333-8444-555555555555';

    const response = await request(app).get('/health').set('X-Request-Id', requestId);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(requestId);
  });
});
