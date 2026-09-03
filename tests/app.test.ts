import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { loadConfig, resetConfigForTests } from '../src/config/index';
import { resetLoggerForTests } from '../src/shared/logger/logger';

describe('application bootstrap', () => {
  beforeEach(() => {
    resetConfigForTests();
    resetLoggerForTests();
    loadConfig();
  });

  it('creates an Express application that accepts requests', async () => {
    const app = createApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});
