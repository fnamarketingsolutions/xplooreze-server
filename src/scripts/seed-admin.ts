import 'dotenv/config';

import { loadConfig } from '../config/index';
import { connectDatabase, disconnectDatabase } from '../database/index';
import { readAdminBootstrapCredentials, seedFirstAdmin } from '../modules/users/admin-bootstrap';
import { getLogger } from '../shared/logger/logger';

async function main(): Promise<void> {
  loadConfig();
  const credentials = readAdminBootstrapCredentials(process.env);

  await connectDatabase();

  try {
    const result = await seedFirstAdmin(credentials);
    getLogger({ module: 'seed-admin' }).info(
      { created: result.created, userId: result.userId },
      result.created ? 'First admin created' : 'First admin already exists',
    );
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Admin bootstrap failed';
  console.error('Admin bootstrap failed:', message);
  process.exit(1);
});
