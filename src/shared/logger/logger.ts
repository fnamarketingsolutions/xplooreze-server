import pino from 'pino';

import { getConfig } from '../../config/index';

export type LogBindings = {
  requestId?: string;
  module?: string;
  event?: string;
  errorCode?: string;
  [key: string]: unknown;
};

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|api[_-]?key|cookie|credential|jwt)/i;

function redactValue(_key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    return '[REDACTED]';
  }
  return '[REDACTED]';
}

function redactBindings(bindings: LogBindings): LogBindings {
  const safe: LogBindings = {};

  for (const [key, value] of Object.entries(bindings)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      safe[key] = redactValue(key, value);
      continue;
    }
    safe[key] = value;
  }

  return safe;
}

function createRootLogger() {
  const { env } = getConfig();

  return pino({
    level: env.logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    redact: {
      paths: [
        'password',
        'smtpPassword',
        'token',
        'secret',
        'credentials',
        'smtp.credentials',
        'smtp.password',
        'authorization',
        'headers.authorization',
        'req.headers.authorization',
        'body.password',
        'body.token',
        'razorpay*',
        'jwt*',
      ],
      censor: '[REDACTED]',
    },
  });
}

let rootLogger: pino.Logger | null = null;

export function getLogger(bindings?: LogBindings): pino.Logger {
  if (!rootLogger) {
    rootLogger = createRootLogger();
  }

  if (!bindings) {
    return rootLogger;
  }

  return rootLogger.child(redactBindings(bindings));
}

export function resetLoggerForTests(): void {
  rootLogger = null;
}
