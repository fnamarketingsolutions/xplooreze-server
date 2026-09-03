#!/usr/bin/env node
/**
 * Live Razorpay webhook smoke tests against a running server (local or ngrok).
 *
 * Usage:
 *   node scripts/test-webhook-live.mjs
 *   WEBHOOK_BASE_URL=https://your-ngrok-url.ngrok-free.dev node scripts/test-webhook-live.mjs
 *   node scripts/test-webhook-live.mjs --order-id order_xxx --amount 49900
 *
 * Reads RAZORPAY_WEBHOOK_SECRET from xplooreze-server/.env
 */

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

function loadEnv() {
  const values = {};
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function parseArgs(argv) {
  const args = { orderId: null, amount: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--order-id') args.orderId = argv[++i];
    if (argv[i] === '--amount') args.amount = Number(argv[++i]);
  }
  return args;
}

function paymentCapturedPayload({ paymentId, orderId, amount, currency }) {
  return {
    entity: 'event',
    account_id: 'acc_test',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount,
          currency,
          status: 'captured',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
}

async function post(baseUrl, body, { signature, eventId, omitSignature = false } = {}) {
  const headers = {
    'content-type': 'application/json',
    'ngrok-skip-browser-warning': '1',
  };
  if (eventId) {
    headers['x-razorpay-event-id'] = eventId;
  }
  if (!omitSignature) {
    headers['x-razorpay-signature'] = signature;
  }

  const response = await fetch(`${baseUrl}/webhooks/razorpay`, {
    method: 'POST',
    headers,
    body,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

function printResult(label, result) {
  console.log(`\n[${label}] HTTP ${result.status}`);
  console.log(JSON.stringify(result.body, null, 2));
}

async function main() {
  const env = loadEnv();
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET missing in .env');
  }

  const baseUrl = (process.env.WEBHOOK_BASE_URL ?? 'http://localhost:5010').replace(/\/$/, '');
  const args = parseArgs(process.argv);
  const orderId = args.orderId ?? `order_manual_${Date.now()}`;
  const amount = args.amount ?? 49900;

  console.log(`Target: ${baseUrl}/webhooks/razorpay`);
  console.log(`Using order_id=${orderId}, amount=${amount}`);

  const eventId = `evt_manual_${Date.now()}`;
  const validPayload = paymentCapturedPayload({
    paymentId: `pay_manual_${randomUUID().slice(0, 8)}`,
    orderId,
    amount,
    currency: 'INR',
  });
  const validBody = JSON.stringify(validPayload);
  const validSig = sign(secret, validBody);

  printResult(
    '1 valid signature',
    await post(baseUrl, validBody, { signature: validSig, eventId }),
  );
  printResult(
    '2 duplicate replay',
    await post(baseUrl, validBody, { signature: validSig, eventId }),
  );

  const badSigBody = JSON.stringify(
    paymentCapturedPayload({
      paymentId: `pay_manual_bad_${randomUUID().slice(0, 8)}`,
      orderId,
      amount,
      currency: 'INR',
    }),
  );
  printResult(
    '3 invalid signature',
    await post(baseUrl, badSigBody, {
      signature: 'deadbeef',
      eventId: `evt_manual_bad_${Date.now()}`,
    }),
  );

  printResult('4 missing signature', await post(baseUrl, validBody, { omitSignature: true, eventId }));

  const mismatchEventId = `evt_manual_mismatch_${Date.now()}`;
  const mismatchBody = JSON.stringify(
    paymentCapturedPayload({
      paymentId: 'pay_manual_mismatch',
      orderId,
      amount: amount - 100,
      currency: 'INR',
    }),
  );
  printResult(
    '5 amount mismatch (real order only)',
    await post(baseUrl, mismatchBody, {
      signature: sign(secret, mismatchBody),
      eventId: mismatchEventId,
    }),
  );

  console.log('\nManual checkout checklist:');
  console.log('1. Razorpay dashboard webhook URL -> https://<ngrok>/webhooks/razorpay');
  console.log('2. Subscribe payment.captured and payment.failed');
  console.log('3. Start a paid purchase in the app and complete Razorpay test checkout');
  console.log('4. Confirm purchase -> PAID, entitlement -> ACTIVE, webhook event recorded');
  console.log('5. Retry failed payment with test card 4111 1111 1111 1111 + invalid expiry/CVV');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
