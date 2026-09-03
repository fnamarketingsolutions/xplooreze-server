import { optionalString, requireString } from './env-helpers';

export type NodeEnv = 'development' | 'test' | 'production';

export type EnvConfig = {
  nodeEnv: NodeEnv;
  port: number;
  logLevel: string;
  corsOrigin: string[];
};

const VALID_NODE_ENVS: ReadonlySet<string> = new Set(['development', 'test', 'production']);

function parsePort(value: string | undefined): number {
  const raw = value === undefined || value.trim() === '' ? '5010' : value.trim();
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${raw}`);
  }

  return port;
}

function parseNodeEnv(value: string | undefined): NodeEnv {
  const nodeEnv = value === undefined || value.trim() === '' ? 'development' : value.trim();

  if (!VALID_NODE_ENVS.has(nodeEnv)) {
    throw new Error(
      `Invalid NODE_ENV value: ${nodeEnv}. Expected one of development, test, production.`,
    );
  }

  return nodeEnv as NodeEnv;
}

function parseCorsOrigin(value: string | undefined, nodeEnv: NodeEnv): string[] {
  const raw = optionalString(value);

  if (!raw) {
    if (nodeEnv === 'production') {
      throw new Error('Missing required environment variable: CORS_ORIGIN');
    }
    return ['http://localhost:5173'];
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Always-required application configuration for process boot.
 * Integration secrets (MongoDB/Blob/Razorpay/auth) are validated when those
 * integrations are initialized — not here.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const port = parsePort(env.PORT);
  const logLevel = optionalString(env.LOG_LEVEL) ?? (nodeEnv === 'production' ? 'info' : 'debug');
  const corsOrigin = parseCorsOrigin(env.CORS_ORIGIN, nodeEnv);

  if (nodeEnv === 'production') {
    requireString(env.CORS_ORIGIN, 'CORS_ORIGIN');
  }

  return {
    nodeEnv,
    port,
    logLevel,
    corsOrigin,
  };
}
