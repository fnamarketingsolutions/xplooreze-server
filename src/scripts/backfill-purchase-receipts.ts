import 'dotenv/config';

import { loadConfig } from '../config/index';
import { connectDatabase, disconnectDatabase } from '../database/index';
import { backfillPurchaseReceipts } from '../modules/purchases/purchase-receipt';
import { getLogger } from '../shared/logger/logger';

const logger = getLogger({ module: 'backfill-purchase-receipts' });

async function main(): Promise<void> {
  loadConfig();
  await connectDatabase();

  try {
    const result = await backfillPurchaseReceipts();
    logger.info(result, 'Purchase receipt backfill complete');

    if (result.skippedNoEntitlement.length > 0) {
      console.error(
        'Skipped PAID purchases with no entitlement grantedAt:',
        result.skippedNoEntitlement.join(', '),
      );
    }
    if (result.skippedNoSeriesTitle.length > 0) {
      console.error(
        'Skipped PAID purchases with no test series title:',
        result.skippedNoSeriesTitle.join(', '),
      );
    }

    if (result.skippedNoEntitlement.length > 0 || result.skippedNoSeriesTitle.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Purchase receipt backfill failed';
  console.error('Purchase receipt backfill failed:', message);
  process.exit(1);
});
