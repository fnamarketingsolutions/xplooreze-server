import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, resetConfigForTests } from '../src/config/index';
import {
  connectDatabase,
  isDatabaseReady,
  resetDatabaseStateForTests,
} from '../src/database/connection';
import { resetLoggerForTests } from '../src/shared/logger/logger';
import { clearCleanupHandlersForTests } from '../src/shared/shutdown/graceful-shutdown';

vi.mock('mongoose', () => {
  const connection = { readyState: 0 };

  return {
    default: {
      connection,
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
  };
});

describe('MongoDB connection infrastructure', () => {
  beforeEach(() => {
    resetConfigForTests();
    resetDatabaseStateForTests();
    clearCleanupHandlersForTests();
    resetLoggerForTests();
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    vi.mocked(mongoose.connect).mockReset();
    vi.mocked(mongoose.disconnect).mockReset();
    vi.mocked(mongoose.connect).mockResolvedValue(mongoose as never);
    vi.mocked(mongoose.disconnect).mockResolvedValue(undefined);
    mongoose.connection.readyState = 0;
  });

  afterEach(() => {
    resetDatabaseStateForTests();
    clearCleanupHandlersForTests();
  });

  it('fails when MONGODB_URI is missing without exposing secrets', async () => {
    await expect(connectDatabase()).rejects.toThrow('Missing required configuration: MONGODB_URI');
    expect(mongoose.connect).not.toHaveBeenCalled();
  });

  it('connects with a provided URI and reports readiness', async () => {
    vi.mocked(mongoose.connect).mockImplementation(async () => {
      mongoose.connection.readyState = 1;
      return mongoose as never;
    });

    await connectDatabase('mongodb://localhost:27017/xplooreze-test');

    expect(mongoose.connect).toHaveBeenCalledTimes(1);
    expect(mongoose.connect).toHaveBeenCalledWith('mongodb://localhost:27017/xplooreze-test');
    expect(isDatabaseReady()).toBe(true);
  });

  it('maps connection failures to a safe error message', async () => {
    vi.mocked(mongoose.connect).mockRejectedValue(
      new Error('connect ECONNREFUSED mongodb://user:secret@localhost:27017'),
    );

    try {
      await connectDatabase('mongodb://user:secret@localhost:27017/app');
      expect.unreachable('expected connectDatabase to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('Failed to connect to MongoDB');
      expect(message).not.toContain('secret');
    }
  });
});
