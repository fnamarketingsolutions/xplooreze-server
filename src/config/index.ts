import { loadAuthConfig } from './auth';
import type { AuthConfig } from './auth';
import { loadBlobConfig } from './blob';
import type { BlobConfig } from './blob';
import { loadDatabaseConfig } from './database';
import type { DatabaseConfig } from './database';
import { loadEnvConfig } from './env';
import type { EnvConfig } from './env';
import { loadEmailConfig } from './email';
import type { EmailConfig } from './email';
import { loadJobsConfig } from './jobs';
import type { JobsConfig } from './jobs';
import { loadRazorpayConfig } from './razorpay';
import type { RazorpayConfig } from './razorpay';

export type AppConfig = {
  env: EnvConfig;
  database: DatabaseConfig;
  blob: BlobConfig;
  razorpay: RazorpayConfig;
  auth: AuthConfig;
  email: EmailConfig;
  jobs: JobsConfig;
};

let cachedConfig: AppConfig | null = null;

/**
 * Loads application configuration.
 * Always-required boot settings are validated immediately.
 * Integration settings are loaded optionally and validated when those clients connect.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    env: loadEnvConfig(env),
    database: loadDatabaseConfig(env),
    blob: loadBlobConfig(env),
    razorpay: loadRazorpayConfig(env),
    auth: loadAuthConfig(env),
    email: loadEmailConfig(env),
    jobs: loadJobsConfig(env),
  };

  cachedConfig = config;
  return config;
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = null;
}

export { requireAuthConfig, parseTtlToMs } from './auth';
export { requireBlobConfig } from './blob';
export { requireDatabaseConfig } from './database';
export { requireEmailConfig } from './email';
export { requireRazorpayConfig, requireRazorpayWebhookSecret } from './razorpay';
