import { optionalString, requireConfigString } from './env-helpers';

export type DatabaseConfig = {
  uri?: string;
};

export type RequiredDatabaseConfig = {
  uri: string;
};

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return {
    uri: optionalString(env.MONGODB_URI),
  };
}

/**
 * Validates MongoDB configuration when the database integration is initialized.
 * Does not echo URI values (may contain credentials) in error messages.
 */
export function requireDatabaseConfig(config: DatabaseConfig): RequiredDatabaseConfig {
  return {
    uri: requireConfigString(config.uri, 'MONGODB_URI'),
  };
}
