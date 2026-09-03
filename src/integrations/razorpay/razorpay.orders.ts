import type Razorpay from 'razorpay';

import { getRazorpayClient } from './razorpay.client';

export type CreateRazorpayOrderInput = {
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
};

export type RazorpayOrderResult = {
  id: string;
  amount: number;
  currency: string;
  receipt?: string | null;
  status?: string;
};

export type RazorpayPaymentResult = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
};

export async function createRazorpayOrder(
  input: CreateRazorpayOrderInput,
  client: Razorpay = getRazorpayClient(),
): Promise<RazorpayOrderResult> {
  const order = await client.orders.create({
    amount: input.amount,
    currency: input.currency,
    receipt: input.receipt,
    ...(input.notes ? { notes: input.notes } : {}),
  });

  return {
    id: String(order.id),
    amount: Number(order.amount),
    currency: String(order.currency),
    receipt: order.receipt ?? null,
    status: order.status,
  };
}

export async function fetchRazorpayPayment(
  paymentId: string,
  client: Razorpay = getRazorpayClient(),
): Promise<RazorpayPaymentResult> {
  const payment = await client.payments.fetch(paymentId);

  return {
    id: String(payment.id),
    order_id: String(payment.order_id),
    amount: Number(payment.amount),
    currency: String(payment.currency),
    status: String(payment.status),
  };
}
