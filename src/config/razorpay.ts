import { optionalString, requireConfigString } from './env-helpers';

export type RazorpayConfig = {
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
};

export type RequiredRazorpayConfig = {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
};

export function loadRazorpayConfig(env: NodeJS.ProcessEnv = process.env): RazorpayConfig {
  return {
    keyId: optionalString(env.RAZORPAY_KEY_ID),
    keySecret: optionalString(env.RAZORPAY_KEY_SECRET),
    webhookSecret: optionalString(env.RAZORPAY_WEBHOOK_SECRET),
  };
}

/**
 * Validates Razorpay configuration when the Razorpay integration is initialized.
 * Never includes key/secret values in error messages.
 */
export function requireRazorpayConfig(config: RazorpayConfig): RequiredRazorpayConfig {
  return {
    keyId: requireConfigString(config.keyId, 'RAZORPAY_KEY_ID'),
    keySecret: requireConfigString(config.keySecret, 'RAZORPAY_KEY_SECRET'),
    webhookSecret: config.webhookSecret,
  };
}

export function requireRazorpayWebhookSecret(
  config: RazorpayConfig = loadRazorpayConfig(),
): string {
  return requireConfigString(config.webhookSecret, 'RAZORPAY_WEBHOOK_SECRET');
}
