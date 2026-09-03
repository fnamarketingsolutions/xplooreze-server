import {
  asRecord,
  readObjectId,
  readString,
  rejectUnknownFields,
} from '../../shared/validation/http';

const VERIFY_FIELDS = [
  'purchaseId',
  'razorpayOrderId',
  'razorpayPaymentId',
  'razorpaySignature',
] as const;

export type VerifyPaymentBody = {
  purchaseId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
};

export function parseVerifyPaymentInput(body: unknown): VerifyPaymentBody {
  const record = asRecord(body);
  rejectUnknownFields(record, VERIFY_FIELDS);

  return {
    purchaseId: readObjectId(record.purchaseId, 'purchaseId'),
    razorpayOrderId: readString(record.razorpayOrderId, 'razorpayOrderId').trim(),
    razorpayPaymentId: readString(record.razorpayPaymentId, 'razorpayPaymentId').trim(),
    razorpaySignature: readString(record.razorpaySignature, 'razorpaySignature').trim(),
  };
}
