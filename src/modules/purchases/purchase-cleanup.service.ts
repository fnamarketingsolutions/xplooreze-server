import { STALE_PENDING_PURCHASE_MS } from '../../database/models/conventions';
import { purchaseRepository } from '../../database/repositories/index';
import { getLogger } from '../../shared/logger/logger';

export type PurchaseCleanupSummary = {
  stalePendingFailed: number;
};

export async function runPurchaseCleanup(now = new Date()): Promise<PurchaseCleanupSummary> {
  const cutoff = new Date(now.getTime() - STALE_PENDING_PURCHASE_MS);
  const stalePending = await purchaseRepository.findPendingCreatedBefore(cutoff);
  let stalePendingFailed = 0;

  for (const purchase of stalePending) {
    const updated = await purchaseRepository.markFailedIfPending(purchase._id);

    if (!updated) {
      continue;
    }

    stalePendingFailed += 1;
    getLogger({ module: 'purchases' }).info(
      {
        event: 'PAYMENT_FAILED',
        purchaseId: updated._id.toString(),
        studentId: updated.studentId.toString(),
        testSeriesId: updated.testSeriesId.toString(),
        reason: 'STALE_PENDING_CLEANUP',
      },
      'Stale pending purchase marked FAILED',
    );
  }

  return { stalePendingFailed };
}
