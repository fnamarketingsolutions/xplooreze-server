import { getConfig } from '../config/index';
import { requireBlobConfig } from '../config/blob';
import { runBlobCleanup } from '../modules/files/blob-cleanup.service';
import { getLogger } from '../shared/logger/logger';
import { registerCleanupHandler } from '../shared/shutdown/graceful-shutdown';

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

function isBlobConfigured(): boolean {
  try {
    requireBlobConfig(getConfig().blob);
    return true;
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  if (running) {
    getLogger({ module: 'jobs', event: 'BLOB_CLEANUP_SKIPPED' }).warn(
      'Blob cleanup skipped because a previous run is still in progress',
    );
    return;
  }

  running = true;
  try {
    await runBlobCleanup();
  } catch (error) {
    getLogger({ module: 'jobs', event: 'BLOB_CLEANUP_FAILED' }).error(
      { err: error },
      'Blob cleanup run failed',
    );
  } finally {
    running = false;
  }
}

export function startBlobCleanupJob(): void {
  const { cleanupEnabled, cleanupIntervalMs } = getConfig().blob;

  if (!cleanupEnabled) {
    getLogger({ module: 'jobs', event: 'BLOB_CLEANUP_DISABLED' }).info(
      'Blob cleanup job disabled by configuration',
    );
    return;
  }

  if (!isBlobConfigured()) {
    getLogger({ module: 'jobs', event: 'BLOB_CLEANUP_DISABLED' }).info(
      'Blob cleanup job not started because Blob credentials are not configured',
    );
    return;
  }

  if (intervalHandle) {
    return;
  }

  intervalHandle = setInterval(() => {
    void tick();
  }, cleanupIntervalMs);

  // Do not keep the process alive solely for the interval when tests/scripts exit.
  intervalHandle.unref?.();

  registerCleanupHandler(() => {
    stopBlobCleanupJob();
  });

  getLogger({ module: 'jobs', event: 'BLOB_CLEANUP_STARTED' }).info(
    { intervalMs: cleanupIntervalMs },
    'Blob cleanup job scheduled',
  );
}

export function stopBlobCleanupJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function resetBlobCleanupJobForTests(): void {
  stopBlobCleanupJob();
  running = false;
}
