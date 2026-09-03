import type { Schema } from 'mongoose';

export function findDeclaredIndex(schema: Schema, key: Record<string, 1 | -1>) {
  return schema.indexes().find(([indexKey]) => {
    const actualKeys = Object.keys(indexKey);
    const expectedKeys = Object.keys(key);
    return (
      actualKeys.length === expectedKeys.length &&
      expectedKeys.every((field) => indexKey[field] === key[field])
    );
  });
}

export function hasDeclaredIndex(schema: Schema, key: Record<string, 1 | -1>): boolean {
  return Boolean(findDeclaredIndex(schema, key));
}
