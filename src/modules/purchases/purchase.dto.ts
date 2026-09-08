import type { TestSeriesSummaryDto } from '../test-series/test-series-summary';

export type PurchaseTestSeriesSummaryDto = TestSeriesSummaryDto;

export type PurchaseReceiptDto = {
  number: string;
  issuedAt: string;
};

export type PurchaseDto = {
  id: string;
  studentId: string;
  testSeriesId: string;
  amount: number;
  currency: string;
  status: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  receipt: PurchaseReceiptDto | null;
  createdAt: string;
  updatedAt: string;
  testSeries: PurchaseTestSeriesSummaryDto | null;
};

export type CreatePurchaseCheckoutDto = {
  purchaseId: string;
  razorpayOrderId: string;
  razorpayKeyId: string;
  amount: number;
  currency: string;
};

type PurchaseLike = {
  _id: { toString(): string };
  studentId: { toString(): string };
  testSeriesId: { toString(): string };
  amount: number;
  currency: string;
  status: string;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  receipt?: { number?: string | null; issuedAt?: Date | null } | null;
  createdAt: Date;
  updatedAt: Date;
};

function toReceiptDto(
  receipt: PurchaseLike['receipt'],
): PurchaseReceiptDto | null {
  if (!receipt?.number || !(receipt.issuedAt instanceof Date)) {
    return null;
  }

  return {
    number: receipt.number,
    issuedAt: receipt.issuedAt.toISOString(),
  };
}

export function toPurchaseDto(
  purchase: PurchaseLike,
  testSeries: PurchaseTestSeriesSummaryDto | null = null,
): PurchaseDto {
  return {
    id: purchase._id.toString(),
    studentId: purchase.studentId.toString(),
    testSeriesId: purchase.testSeriesId.toString(),
    amount: purchase.amount,
    currency: purchase.currency,
    status: purchase.status,
    razorpayOrderId: purchase.razorpayOrderId ?? null,
    razorpayPaymentId: purchase.razorpayPaymentId ?? null,
    receipt: toReceiptDto(purchase.receipt),
    createdAt: purchase.createdAt.toISOString(),
    updatedAt: purchase.updatedAt.toISOString(),
    testSeries,
  };
}
