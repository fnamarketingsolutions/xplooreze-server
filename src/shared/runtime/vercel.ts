/**
 * Vercel sets `VERCEL=1` in build and runtime environments.
 * Used to adapt bootstrapping (DB ensure) and default off in-process interval jobs.
 */
export function isVercelRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VERCEL?.trim();
  return raw === '1' || raw?.toLowerCase() === 'true';
}
