import 'dotenv/config';

import { loadConfig } from './config/index';
import { createApp } from './create-app';
import { connectDatabase } from './database/index';
import { startBlobCleanupJob, startPurchaseCleanupJob } from './jobs/index';
import { getLogger } from './shared/logger/logger';
import { isVercelRuntime } from './shared/runtime/vercel';
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

  // In-process interval jobs are unreliable on Vercel; defaults are off when VERCEL=1.
  if (!isVercelRuntime()) {
    startBlobCleanupJob();
    startPurchaseCleanupJob();
  } else {
    logger.info('Skipping in-process cleanup jobs on Vercel runtime');
  }
  setupGracefulShutdown(server);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error('Failed to start server:', message);
  process.exit(1);
});
