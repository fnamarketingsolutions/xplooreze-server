import type { TestSeriesSummaryDto } from '../test-series/test-series-summary';

export type PurchaseTestSeriesSummaryDto = TestSeriesSummaryDto;

export type PurchaseDto = {
  id: string;
  studentId: string;
  testSeriesId: string;
  amount: number;
  currency: string;
  status: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
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
  createdAt: Date;
  updatedAt: Date;
};

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
    createdAt: purchase.createdAt.toISOString(),
    updatedAt: purchase.updatedAt.toISOString(),
    testSeries,
  };
}
