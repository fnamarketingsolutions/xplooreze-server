import { describe, expect, it } from 'vitest';

import {
  formatReceiptIssuedAt,
  formatReceiptNumber,
  receiptYear,
} from '../src/modules/purchases/purchase-receipt';

describe('purchase receipt numbers', () => {
  it('uses the Asia/Kolkata calendar year and a yearly padded sequence', () => {
    expect(receiptYear(new Date('2025-12-31T18:29:59.000Z'))).toBe(2025);
    expect(receiptYear(new Date('2025-12-31T18:30:00.000Z'))).toBe(2026);
    expect(formatReceiptNumber(2026, 1)).toBe('XP-2026-000001');
    expect(formatReceiptNumber(2026, 42)).toBe('XP-2026-000042');
  });

  it('formats the issued time in Asia/Kolkata', () => {
    expect(formatReceiptIssuedAt(new Date('2026-02-01T04:30:00.000Z'))).toContain('2026');
    expect(formatReceiptIssuedAt(new Date('2026-02-01T04:30:00.000Z'))).toContain('10:00');
  });
});
