import type { Server } from 'node:http';

import { getLogger } from '../logger/logger';

export type CleanupHandler = () => Promise<void> | void;

const cleanupHandlers: CleanupHandler[] = [];

export function registerCleanupHandler(handler: CleanupHandler): void {
  cleanupHandlers.push(handler);
}

export function clearCleanupHandlersForTests(): void {
  cleanupHandlers.length = 0;
}

export function setupGracefulShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const logger = getLogger({ module: 'shutdown' });
    logger.info({ signal }, 'Graceful shutdown started');

    server.close(async (closeError) => {
      if (closeError) {
        logger.error({ err: closeError }, 'Error while closing HTTP server');
        process.exit(1);
        return;
      }

      try {
        for (const handler of cleanupHandlers) {
          await handler();
        }
        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (cleanupError) {
        logger.error({ err: cleanupError }, 'Error during shutdown cleanup');
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}
