import argon2 from 'argon2';

const TEST_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 4096,
  timeCost: 1,
  parallelism: 1,
} as const;

const PRODUCTION_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

function hashOptions() {
  return process.env.NODE_ENV === 'test' ? TEST_OPTIONS : PRODUCTION_OPTIONS;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, hashOptions());
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}
