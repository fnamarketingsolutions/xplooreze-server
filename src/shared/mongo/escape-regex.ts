/** Escape a string for safe use inside a MongoDB `$regex` pattern. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
