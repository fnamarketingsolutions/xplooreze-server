import { getConfig } from '../config/index';
import { runPurchaseCleanup } from '../modules/purchases/purchase-cleanup.service';
import { getLogger } from '../shared/logger/logger';
import { registerCleanupHandler } from '../shared/shutdown/graceful-shutdown';

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) {
    getLogger({ module: 'jobs', event: 'PURCHASE_CLEANUP_SKIPPED' }).warn(
      'Purchase cleanup skipped because a previous run is still in progress',
    );
    return;
  }

  running = true;
  try {
    const summary = await runPurchaseCleanup();
    if (summary.stalePendingFailed > 0) {
      getLogger({ module: 'jobs', event: 'PURCHASE_CLEANUP_COMPLETED' }).info(
        { stalePendingFailed: summary.stalePendingFailed },
        'Purchase cleanup run completed',
      );
    }
  } catch (error) {
    getLogger({ module: 'jobs', event: 'PURCHASE_CLEANUP_FAILED' }).error(
      { err: error },
      'Purchase cleanup run failed',
    );
  } finally {
    running = false;
  }
}

export function startPurchaseCleanupJob(): void {
  const { purchaseCleanupEnabled, purchaseCleanupIntervalMs } = getConfig().jobs;

  if (!purchaseCleanupEnabled) {
    getLogger({ module: 'jobs', event: 'PURCHASE_CLEANUP_DISABLED' }).info(
      'Purchase cleanup job disabled by configuration',
    );
    return;
  }

  if (intervalHandle) {
    return;
  }

  intervalHandle = setInterval(() => {
    void tick();
  }, purchaseCleanupIntervalMs);

  intervalHandle.unref?.();

  registerCleanupHandler(() => {
    stopPurchaseCleanupJob();
  });

  getLogger({ module: 'jobs', event: 'PURCHASE_CLEANUP_STARTED' }).info(
    { intervalMs: purchaseCleanupIntervalMs },
    'Purchase cleanup job scheduled',
  );
}

export function stopPurchaseCleanupJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function resetPurchaseCleanupJobForTests(): void {
  stopPurchaseCleanupJob();
  running = false;
}
