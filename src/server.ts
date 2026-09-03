import 'dotenv/config';

import { createApp } from './app';
import { loadConfig } from './config/index';
import { connectDatabase } from './database/index';
import { startBlobCleanupJob, startPurchaseCleanupJob } from './jobs/index';
import { getLogger } from './shared/logger/logger';
import { setupGracefulShutdown } from './shared/shutdown/graceful-shutdown';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = getLogger({ module: 'server' });

  await connectDatabase();

  const app = createApp();

  const server = app.listen(config.env.port, () => {
    logger.info(
      {
        port: config.env.port,
        nodeEnv: config.env.nodeEnv,
      },
      'HTTP server listening',
    );
  });

  startBlobCleanupJob();
  startPurchaseCleanupJob();
  setupGracefulShutdown(server);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error('Failed to start server:', message);
  process.exit(1);
});
