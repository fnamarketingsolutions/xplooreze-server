import mongoose from 'mongoose';

import { getConfig, requireDatabaseConfig } from '../config/index';
import { getLogger } from '../shared/logger/logger';
import { registerCleanupHandler } from '../shared/shutdown/graceful-shutdown';

let cleanupRegistered = false;
let connectPromise: Promise<typeof mongoose> | null = null;

function registerDisconnectCleanup(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  registerCleanupHandler(async () => {
    await disconnectDatabase();
  });
}

/**
 * Establishes the shared Mongoose connection.
 * Safe to call multiple times; concurrent callers share one connect attempt.
 * Does not create collections, indexes, or domain models.
 */
export async function connectDatabase(uri?: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    registerDisconnectCleanup();
    return mongoose;
  }

  if (connectPromise) {
    return connectPromise;
  }

  const resolvedUri = uri ?? requireDatabaseConfig(getConfig().database).uri;
  const logger = getLogger({ module: 'database' });

  connectPromise = (async () => {
    logger.info('Connecting to MongoDB');

    try {
      await mongoose.connect(resolvedUri);
      registerDisconnectCleanup();
      logger.info('MongoDB connected');
      return mongoose;
    } catch (error) {
      // Never log the URI or driver messages that may embed credentials.
      logger.error(
        {
          err:
            error instanceof Error
              ? { name: error.name, message: 'MongoDB connection failed' }
              : { message: 'MongoDB connection failed' },
        },
        'MongoDB connection failed',
      );
      throw new Error('Failed to connect to MongoDB', { cause: error });
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  const logger = getLogger({ module: 'database' });
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
}

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export function getMongoose(): typeof mongoose {
  return mongoose;
}

/** Test helper: clears connect-state flags. Does not open a real connection. */
export function resetDatabaseStateForTests(): void {
  connectPromise = null;
  cleanupRegistered = false;
}
