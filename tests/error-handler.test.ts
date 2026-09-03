import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resetConfigForTests } from '../src/config/index';
import { errorHandler } from '../src/middleware/error-handler';
import { requestIdMiddleware } from '../src/middleware/request-id';
import { AppError, ErrorCodes } from '../src/shared/errors/app-error';
import { resetLoggerForTests } from '../src/shared/logger/logger';

describe('centralized error handling', () => {
  beforeEach(() => {
    resetConfigForTests();
    resetLoggerForTests();
    loadConfig();
  });

  it('maps AppError to the standard API error envelope', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/operational', (_req, _res, next) => {
      next(
        new AppError({
          statusCode: 409,
          code: 'CONFLICT_EXAMPLE',
          message: 'Conflict occurred',
          details: { field: 'example' },
        }),
      );
    });
    app.use(errorHandler);

    const response = await request(app).get('/operational');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'CONFLICT_EXAMPLE',
        message: 'Conflict occurred',
        details: { field: 'example' },
      },
    });
    expect(response.body.error).not.toHaveProperty('stack');
  });

  it('maps unexpected errors to INTERNAL_SERVER_ERROR without leaking stacks', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/unexpected', () => {
      throw new Error('secret implementation detail');
    });
    app.use(errorHandler);

    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const response = await request(app).get('/unexpected');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: ErrorCodes.INTERNAL_SERVER_ERROR,
          message: 'An unexpected error occurred.',
        },
      });
      expect(JSON.stringify(response.body)).not.toContain('secret implementation detail');
      expect(response.body.error).not.toHaveProperty('stack');
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });

  it('maps duplicate-key persistence errors without leaking database details', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/duplicate', (_req, _res, next) => {
      next({
        code: 11000,
        message: 'E11000 duplicate key error mongodb://user:secret@localhost:27017',
      });
    });
    app.use(errorHandler);

    const response = await request(app).get('/duplicate');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: ErrorCodes.DUPLICATE_KEY,
        message: 'A conflicting record already exists.',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(JSON.stringify(response.body)).not.toContain('mongodb://');
  });
});
