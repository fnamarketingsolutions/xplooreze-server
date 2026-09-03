import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { resetLoggerForTests } from '../src/shared/logger/logger';

describe('404 handling', () => {
  beforeEach(() => {
    resetConfigForTests();
    resetLoggerForTests();
    loadConfig();
  });

  it('returns a structured not-found error for unknown routes', async () => {
    const app = createApp();

    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route GET /does-not-exist not found',
      },
    });
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});
