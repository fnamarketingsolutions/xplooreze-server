export function requireString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function optionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

/**
 * Builds an Error whose message never echoes secret values.
 * Callers may pass the raw secret only as `providedValue` for emptiness checks;
 * it is never included in the thrown message.
 */
export function missingConfigError(name: string): Error {
  return new Error(`Missing required configuration: ${name}`);
}

export function requireConfigString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw missingConfigError(name);
  }
  return value.trim();
}
