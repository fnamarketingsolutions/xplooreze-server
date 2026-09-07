import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import * as database from '../src/database/index';
import { resetLoggerForTests } from '../src/shared/logger/logger';

describe('GET /ready', () => {
  beforeEach(() => {
    resetConfigForTests();
    resetLoggerForTests();
    loadConfig();
    vi.restoreAllMocks();
  });

  it('returns not ready when MongoDB is not connected', async () => {
    vi.spyOn(database, 'isDatabaseReady').mockReturnValue(false);
    const app = createApp();

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      data: {
        status: 'not_ready',
        checks: {
          mongodb: false,
        },
      },
    });
  });

  it('returns ready when MongoDB is connected', async () => {
    vi.spyOn(database, 'isDatabaseReady').mockReturnValue(true);
    const app = createApp();

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        status: 'ready',
        checks: {
          mongodb: true,
        },
      },
    });
  });
});
