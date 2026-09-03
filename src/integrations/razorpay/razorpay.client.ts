import Razorpay from 'razorpay';

import { getConfig, requireRazorpayConfig } from '../../config/index';
import type { RazorpayConfig } from '../../config/razorpay';
import { getLogger } from '../../shared/logger/logger';

let cached: Razorpay | null = null;

/**
 * Creates a Razorpay SDK client. Does not call the Razorpay API.
 * Validates key configuration at initialization time.
 * Never logs key or secret values.
 */
export function createRazorpayClient(config: RazorpayConfig = getConfig().razorpay): Razorpay {
  const required = requireRazorpayConfig(config);

  return new Razorpay({
    key_id: required.keyId,
    key_secret: required.keySecret,
  });
}

/**
 * Returns a process-wide Razorpay client, initializing it on first use.
 * Stateless HTTP client — no shutdown cleanup required.
 */
export function getRazorpayClient(): Razorpay {
  if (cached) {
    return cached;
  }

  cached = createRazorpayClient();
  getLogger({ module: 'razorpay' }).info('Razorpay client initialized');
  return cached;
}

export function resetRazorpayClientForTests(): void {
  cached = null;
}
