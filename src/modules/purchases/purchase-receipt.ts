import type { ClientSession } from 'mongoose';

import { withTransaction } from '../../database/transactions';
import { CounterModel } from '../../database/models/counter.model';
import { EntitlementModel } from '../../database/models/entitlement.model';
import { PurchaseModel } from '../../database/models/purchase.model';
import { TestSeriesModel } from '../../database/models/test-series.model';
import { UserModel } from '../../database/models/user.model';
import { getLogger } from '../../shared/logger/logger';
import { RECEIPT_SELLER } from './receipt-seller';

export const RECEIPT_TIME_ZONE = 'Asia/Kolkata';
const RECEIPT_NUMBER_PREFIX = 'XP';
const RECEIPT_SEQUENCE_WIDTH = 6;

export type PurchaseReceiptSnapshot = {
  number: string;
  sequence: number;
  year: number;
  issuedAt: Date;
  studentName: string;
  studentEmail: string;
  studentMobileNumber: string;
  testSeriesTitle: string;
  amount: number;
  currency: string;
  razorpayPaymentId: string;
  sellerName: string;
  sellerEmail: string;
  sellerPhone: string;
};

type NameParts = { first?: string | null; last?: string | null };

export function receiptYear(issuedAt: Date): number {
  const year = new Intl.DateTimeFormat('en-US', {
    timeZone: RECEIPT_TIME_ZONE,
    year: 'numeric',
  }).format(issuedAt);
  return Number(year);
}

export function formatReceiptNumber(year: number, sequence: number): string {
  return `${RECEIPT_NUMBER_PREFIX}-${year}-${String(sequence).padStart(RECEIPT_SEQUENCE_WIDTH, '0')}`;
}

export function formatReceiptIssuedAt(issuedAt: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: RECEIPT_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h12',
    timeZoneName: 'short',
  }).format(issuedAt);
}

export function formatStudentName(name: NameParts | null | undefined): string {
  if (!name) {
    return '';
  }
  return [name.first, name.last]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '')
    .join(' ');
}

function receiptCounterKey(year: number): string {
  return `purchaseReceipt:${year}`;
}

async function allocateReceiptSequence(year: number, session: ClientSession): Promise<number> {
  const counter = await CounterModel.findOneAndUpdate(
    { key: receiptCounterKey(year) },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).exec();

  if (!counter || typeof counter.seq !== 'number' || counter.seq < 1) {
    throw new Error(`Failed to allocate purchase receipt sequence for ${year}.`);
  }

  return counter.seq;
}

function receiptAlreadyIssuedFilter() {
  return {
    $or: [{ receipt: null }, { receipt: { $exists: false } }],
  };
}

export async function issuePurchaseReceipt(input: {
  purchaseId: string;
  studentId: string;
  testSeriesId: string;
  issuedAt: Date;
  amount: number;
  currency: string;
  razorpayPaymentId?: string | null;
  session: ClientSession;
}) {
  const existing = await PurchaseModel.findById(input.purchaseId).session(input.session).exec();
  if (existing?.receipt?.number) {
    return existing;
  }

  const [student, testSeries] = await Promise.all([
    UserModel.findById(input.studentId).session(input.session).exec(),
    TestSeriesModel.findById(input.testSeriesId).session(input.session).exec(),
  ]);

  const year = receiptYear(input.issuedAt);
  const sequence = await allocateReceiptSequence(year, input.session);
  const receipt: PurchaseReceiptSnapshot = {
    number: formatReceiptNumber(year, sequence),
    sequence,
    year,
    issuedAt: input.issuedAt,
    studentName: formatStudentName(student?.name),
    studentEmail: student?.email ?? '',
    studentMobileNumber: student?.mobileNumber?.trim() ?? '',
    testSeriesTitle: testSeries?.title?.trim() ?? '',
    amount: input.amount,
    currency: input.currency,
    razorpayPaymentId: input.razorpayPaymentId?.trim() ?? '',
    sellerName: RECEIPT_SELLER.name,
    sellerEmail: RECEIPT_SELLER.email,
    sellerPhone: RECEIPT_SELLER.phone,
  };

  const updated = await PurchaseModel.findOneAndUpdate(
    {
      _id: input.purchaseId,
      status: 'PAID',
      ...receiptAlreadyIssuedFilter(),
    },
    { $set: { receipt } },
    { returnDocument: 'after', session: input.session },
  ).exec();

  if (updated) {
    return updated;
  }

  const current = await PurchaseModel.findById(input.purchaseId).session(input.session).exec();
  if (current?.receipt?.number) {
    return current;
  }

  throw new Error(`Failed to issue purchase receipt for ${input.purchaseId}.`);
}

export type PurchaseReceiptBackfillResult = {
  issued: number;
  alreadyIssued: number;
  skippedNoEntitlement: string[];
  skippedNoSeriesTitle: string[];
};

type BackfillCandidate = {
  purchaseId: string;
  studentId: string;
  testSeriesId: string;
  amount: number;
  currency: string;
  razorpayPaymentId: string | null;
  issuedAt: Date;
};

export async function backfillPurchaseReceipts(): Promise<PurchaseReceiptBackfillResult> {
  const logger = getLogger({ module: 'purchase-receipt-backfill' });
  const paid = await PurchaseModel.find({
    status: 'PAID',
    ...receiptAlreadyIssuedFilter(),
  })
    .select({
      studentId: 1,
      testSeriesId: 1,
      amount: 1,
      currency: 1,
      razorpayPaymentId: 1,
    })
    .lean<
      Array<{
        _id: { toString(): string };
        studentId: { toString(): string };
        testSeriesId: { toString(): string };
        amount: number;
        currency: string;
        razorpayPaymentId?: string | null;
      }>
    >()
    .exec();

  const skippedNoEntitlement: string[] = [];
  const skippedNoSeriesTitle: string[] = [];
  const eligible: BackfillCandidate[] = [];

  for (const purchase of paid) {
    const purchaseId = purchase._id.toString();
    const entitlement = await EntitlementModel.findOne({ purchaseId: purchase._id })
      .select({ grantedAt: 1 })
      .lean<{ grantedAt?: Date }>()
      .exec();

    if (!(entitlement?.grantedAt instanceof Date) || Number.isNaN(entitlement.grantedAt.getTime())) {
      skippedNoEntitlement.push(purchaseId);
      continue;
    }

    const testSeries = await TestSeriesModel.findById(purchase.testSeriesId)
      .select({ title: 1 })
      .lean<{ title?: string }>()
      .exec();
    const title = testSeries?.title?.trim() ?? '';
    if (title === '') {
      skippedNoSeriesTitle.push(purchaseId);
      continue;
    }

    eligible.push({
      purchaseId,
      studentId: purchase.studentId.toString(),
      testSeriesId: purchase.testSeriesId.toString(),
      amount: purchase.amount,
      currency: purchase.currency,
      razorpayPaymentId: purchase.razorpayPaymentId ?? null,
      issuedAt: entitlement.grantedAt,
    });
  }

  eligible.sort((left, right) => {
    const byTime = left.issuedAt.getTime() - right.issuedAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return left.purchaseId.localeCompare(right.purchaseId);
  });

  let issued = 0;
  let alreadyIssued = 0;

  for (const candidate of eligible) {
    const result = await withTransaction(async (session) => {
      const before = await PurchaseModel.findById(candidate.purchaseId).session(session).exec();
      if (before?.receipt?.number) {
        return 'already-issued' as const;
      }

      await issuePurchaseReceipt({
        purchaseId: candidate.purchaseId,
        studentId: candidate.studentId,
        testSeriesId: candidate.testSeriesId,
        issuedAt: candidate.issuedAt,
        amount: candidate.amount,
        currency: candidate.currency,
        razorpayPaymentId: candidate.razorpayPaymentId,
        session,
      });
      return 'issued' as const;
    });

    if (result === 'issued') {
      issued += 1;
    } else {
      alreadyIssued += 1;
    }
  }

  logger.info(
    {
      event: 'PURCHASE_RECEIPT_BACKFILL_COMPLETE',
      issued,
      alreadyIssued,
      skippedNoEntitlement: skippedNoEntitlement.length,
      skippedNoSeriesTitle: skippedNoSeriesTitle.length,
    },
    'Purchase receipt backfill complete',
  );

  return {
    issued,
    alreadyIssued,
    skippedNoEntitlement,
    skippedNoSeriesTitle,
  };
}
