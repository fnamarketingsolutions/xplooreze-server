import { optionalString, requireConfigString } from './env-helpers';

export type CookieSameSite = 'lax' | 'strict' | 'none';

export type RefreshCookieConfig = {
  name: string;
  path: string;
  sameSite: CookieSameSite;
  secure: boolean;
};

export type AuthConfig = {
  jwtSecret?: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtl: string;
  refreshTokenTtl: string;
  passwordResetTokenTtl: string;
  passwordResetUrlBase?: string;
  cookie: RefreshCookieConfig;
};

export type RequiredAuthConfig = AuthConfig & {
  jwtSecret: string;
};

const TTL_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const TTL_MULTIPLIERS_MS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

function parseSameSite(value: string | undefined): CookieSameSite {
  const raw = optionalString(value)?.toLowerCase();

  if (!raw) {
    return 'lax';
  }

  if (raw === 'lax' || raw === 'strict' || raw === 'none') {
    return raw;
  }

  throw new Error('Invalid REFRESH_COOKIE_SAMESITE. Expected one of lax, strict, none.');
}

function parseSecureCookie(value: string | undefined, nodeEnv: string | undefined): boolean {
  const raw = optionalString(value)?.toLowerCase();

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  return nodeEnv === 'production';
}

export function parseTtlToMs(ttl: string, name: string): number {
  const match = TTL_PATTERN.exec(ttl.trim());

  if (!match) {
    throw new Error(`Invalid ${name}. Expected a value such as 15m, 7d, or 3600s.`);
  }

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof TTL_MULTIPLIERS_MS;
  return amount * TTL_MULTIPLIERS_MS[unit];
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    jwtSecret: optionalString(env.JWT_SECRET),
    jwtIssuer: optionalString(env.JWT_ISSUER) ?? 'xplooreze',
    jwtAudience: optionalString(env.JWT_AUDIENCE) ?? 'xplooreze-api',
    accessTokenTtl: optionalString(env.JWT_ACCESS_TOKEN_TTL) ?? '15m',
    refreshTokenTtl: optionalString(env.JWT_REFRESH_TOKEN_TTL) ?? '7d',
    passwordResetTokenTtl: optionalString(env.PASSWORD_RESET_TOKEN_TTL) ?? '30m',
    passwordResetUrlBase: optionalString(env.PASSWORD_RESET_URL_BASE),
    cookie: {
      name: optionalString(env.REFRESH_COOKIE_NAME) ?? 'refresh_token',
      path: optionalString(env.REFRESH_COOKIE_PATH) ?? '/auth',
      sameSite: parseSameSite(env.REFRESH_COOKIE_SAMESITE),
      secure: parseSecureCookie(env.REFRESH_COOKIE_SECURE, env.NODE_ENV),
    },
  };
}

/**
 * Validates authentication configuration when auth operations run.
 * Does not echo secret values in error messages.
 */
export function requireAuthConfig(config: AuthConfig): RequiredAuthConfig {
  const jwtSecret = requireConfigString(config.jwtSecret, 'JWT_SECRET');

  if (jwtSecret.length < 32) {
    throw new Error('Invalid JWT_SECRET: must be at least 32 characters.');
  }

  parseTtlToMs(config.accessTokenTtl, 'JWT_ACCESS_TOKEN_TTL');
  parseTtlToMs(config.refreshTokenTtl, 'JWT_REFRESH_TOKEN_TTL');
  parseTtlToMs(config.passwordResetTokenTtl, 'PASSWORD_RESET_TOKEN_TTL');

  if (config.cookie.sameSite === 'none' && !config.cookie.secure) {
    throw new Error('Invalid refresh cookie configuration: SameSite=None requires Secure.');
  }

  return {
    ...config,
    jwtSecret,
  };
}
