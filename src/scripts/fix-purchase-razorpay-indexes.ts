import 'dotenv/config';

import { loadConfig } from '../config/index';
import { connectDatabase, disconnectDatabase } from '../database/index';
import { PurchaseModel } from '../database/models/purchase.model';
import { getLogger } from '../shared/logger/logger';

const logger = getLogger({ module: 'fix-purchase-razorpay-indexes' });

const LEGACY_RAZORPAY_ORDER_INDEX = 'razorpayOrderId_1';
const LEGACY_RAZORPAY_PAYMENT_INDEX = 'razorpayPaymentId_1';

function isLegacySparseUniqueIndex(index: { name?: string; unique?: boolean; sparse?: boolean }) {
  return (
    index.unique === true &&
    index.sparse === true &&
    (index.name === LEGACY_RAZORPAY_ORDER_INDEX || index.name === LEGACY_RAZORPAY_PAYMENT_INDEX)
  );
}

async function dropLegacyIndexes(): Promise<string[]> {
  const indexes = await PurchaseModel.collection.indexes();
  const dropped: string[] = [];

  for (const index of indexes) {
    if (!index.name || !isLegacySparseUniqueIndex(index)) {
      continue;
    }

    await PurchaseModel.collection.dropIndex(index.name);
    dropped.push(index.name);
  }

  return dropped;
}

async function main(): Promise<void> {
  loadConfig();
  await connectDatabase();

  try {
    const dropped = await dropLegacyIndexes();
    await PurchaseModel.syncIndexes();

    logger.info(
      { droppedLegacyIndexes: dropped },
      'Purchase Razorpay indexes reconciled with schema partial unique filters',
    );
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Purchase Razorpay index reconciliation failed';
  console.error('Purchase Razorpay index reconciliation failed:', message);
  process.exit(1);
});
