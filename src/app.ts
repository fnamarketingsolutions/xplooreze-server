/**
 * Vercel Express entrypoint.
 * Vercel auto-detects `src/app.ts` and requires a default-exported Express app
 * (or a listen-based entry). Local long-running boot remains in `server.ts`.
 *
 * @see https://vercel.com/docs/frameworks/backend/express
 */
import { loadConfig } from './config/index';
import { connectDatabase } from './database/index';
import { createApp } from './create-app';
import { getLogger } from './shared/logger/logger';

loadConfig();

const app = createApp();

// Eager connect on instance start; request middleware also awaits connect if still pending.
void connectDatabase().catch((error: unknown) => {
  getLogger({ module: 'app' }).error(
    {
      err:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { message: 'Unknown MongoDB bootstrap error' },
    },
    'MongoDB connect failed during Vercel app bootstrap',
  );
});

export default app;
