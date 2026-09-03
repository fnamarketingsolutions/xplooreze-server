import { createHmac, timingSafeEqual } from 'node:crypto';

import { getConfig, requireRazorpayConfig, requireRazorpayWebhookSecret } from '../../config/index';

function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqualHex(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

export function verifyPaymentSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  keySecret?: string;
}): boolean {
  const secret = input.keySecret ?? requireRazorpayConfig(getConfig().razorpay).keySecret;
  const expected = hmacSha256Hex(secret, `${input.razorpayOrderId}|${input.razorpayPaymentId}`);
  return safeEqualHex(expected, input.razorpaySignature);
}

export function verifyWebhookSignature(input: {
  rawBody: string | Buffer;
  signature: string;
  webhookSecret?: string;
}): boolean {
  const secret = input.webhookSecret ?? requireRazorpayWebhookSecret(getConfig().razorpay);

  const body = typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8');
  const expected = hmacSha256Hex(secret, body);
  return safeEqualHex(expected, input.signature);
}

/** Test helper: builds a valid payment checkout signature. */
export function signPaymentVerification(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  keySecret: string;
}): string {
  return hmacSha256Hex(input.keySecret, `${input.razorpayOrderId}|${input.razorpayPaymentId}`);
}

/** Test helper: builds a valid webhook signature over a raw body. */
export function signWebhookPayload(rawBody: string, webhookSecret: string): string {
  return hmacSha256Hex(webhookSecret, rawBody);
}
