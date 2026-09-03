import { describe, expect, it } from 'vitest';

import { isAvailabilityWindowOpen } from '../src/modules/test-series/test-series.availability';
import {
  parseCreateTestSeriesInput,
  parseUpdateTestSeriesInput,
  resolveAccess,
} from '../src/modules/test-series/test-series.validation';
import { ErrorCodes } from '../src/shared/errors/app-error';

const MODULE_ID = '64b0f2c3a1d2e3f4a5b6c7d8';

describe('test series availability window', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');

  it('treats null boundaries as always available', () => {
    expect(isAvailabilityWindowOpen({ startsAt: null, endsAt: null }, now)).toBe(true);
  });

  it('is closed before startsAt and open at startsAt', () => {
    const startsAt = new Date('2026-08-13T12:00:00.000Z');
    expect(
      isAvailabilityWindowOpen({ startsAt, endsAt: null }, new Date('2026-08-13T11:59:59.999Z')),
    ).toBe(false);
    expect(isAvailabilityWindowOpen({ startsAt, endsAt: null }, startsAt)).toBe(true);
  });

  it('is closed at and after endsAt', () => {
    const endsAt = new Date('2026-08-13T12:00:00.000Z');
    expect(
      isAvailabilityWindowOpen({ startsAt: null, endsAt }, new Date('2026-08-13T11:59:59.999Z')),
    ).toBe(true);
    expect(isAvailabilityWindowOpen({ startsAt: null, endsAt }, endsAt)).toBe(false);
  });
});

describe('test series access rules', () => {
  it('forces MCQ to free INR pricing', () => {
    expect(resolveAccess('MCQ', undefined)).toEqual({
      isFree: true,
      price: 0,
      currency: 'INR',
    });
  });

  it('requires a positive integer paise price for PDF and EDITOR', () => {
    expect(resolveAccess('PDF', { price: 49900 })).toEqual({
      isFree: false,
      price: 49900,
      currency: 'INR',
    });
    expect(resolveAccess('EDITOR', { price: 79900, isFree: false, currency: 'INR' })).toEqual({
      isFree: false,
      price: 79900,
      currency: 'INR',
    });
  });

  it('rejects paid MCQ, free PDF/EDITOR, and non-integer prices', () => {
    expect(() => resolveAccess('MCQ', { isFree: false, price: 100 })).toThrow();
    expect(() => resolveAccess('PDF', { isFree: true, price: 49900 })).toThrow();
    expect(() => resolveAccess('EDITOR', { price: 0 })).toThrow();
    expect(() => resolveAccess('PDF', { price: 499.5 })).toThrow();
    expect(() => resolveAccess('EDITOR', { price: -49900 })).toThrow();
  });
});

describe('test series create validation', () => {
  it('rejects WRITTEN and other non-canonical types', () => {
    const written = () =>
      parseCreateTestSeriesInput({
        moduleId: MODULE_ID,
        title: 'Essay',
        type: 'WRITTEN',
        duration: 3600,
        access: { price: 499 },
      });
    const invalid = () =>
      parseCreateTestSeriesInput({
        moduleId: MODULE_ID,
        title: 'Essay',
        type: 'QUIZ',
        duration: 3600,
      });

    expect(written).toThrow();
    expect(invalid).toThrow();

    try {
      written();
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCodes.VALIDATION_ERROR });
    }
  });

  it('rejects non-positive duration and inverted availability windows', () => {
    const base = {
      moduleId: MODULE_ID,
      title: 'Mock',
      type: 'MCQ',
      scoring: { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 },
    };

    expect(() => parseCreateTestSeriesInput({ ...base, duration: 0 })).toThrow();
    expect(() => parseCreateTestSeriesInput({ ...base, duration: -10 })).toThrow();
    expect(() => parseCreateTestSeriesInput({ ...base, duration: 1.5 })).toThrow();
    expect(() =>
      parseCreateTestSeriesInput({
        ...base,
        duration: 3600,
        availability: {
          startsAt: '2026-08-25T00:00:00.000Z',
          endsAt: '2026-08-20T00:00:00.000Z',
        },
      }),
    ).toThrow();
  });

  it('rejects client-provided attempt policy', () => {
    expect(() =>
      parseCreateTestSeriesInput({
        moduleId: MODULE_ID,
        title: 'Mock',
        type: 'MCQ',
        duration: 3600,
        scoring: { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 },
        attemptPolicy: { maxAttempts: 10 },
      }),
    ).toThrow();
  });
});

describe('test series maxScore', () => {
  const pdfBase = {
    moduleId: MODULE_ID,
    title: 'PDF Mock',
    type: 'PDF' as const,
    duration: 3600,
    access: { price: 49900 },
  };

  it('defaults maxScore to 100 for PDF, EDITOR, and MCQ', () => {
    expect(parseCreateTestSeriesInput(pdfBase).scoring).toEqual({ maxScore: 100 });
    expect(
      parseCreateTestSeriesInput({
        ...pdfBase,
        title: 'Editor Mock',
        type: 'EDITOR',
      }).scoring,
    ).toEqual({ maxScore: 100 });
    expect(
      parseCreateTestSeriesInput({
        moduleId: MODULE_ID,
        title: 'MCQ Mock',
        type: 'MCQ',
        duration: 3600,
        scoring: { correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 },
      }).scoring,
    ).toMatchObject({
      correctMarks: 4,
      incorrectMarks: -1,
      unansweredMarks: 0,
      maxScore: 100,
    });
  });

  it('accepts Admin-configured maxScore with 2 decimal places', () => {
    expect(
      parseCreateTestSeriesInput({
        ...pdfBase,
        scoring: { maxScore: 50 },
      }).scoring.maxScore,
    ).toBe(50);
    expect(
      parseCreateTestSeriesInput({
        ...pdfBase,
        scoring: { maxScore: 82.5 },
      }).scoring.maxScore,
    ).toBe(82.5);
    expect(parseUpdateTestSeriesInput({ scoring: { maxScore: 120 } }).scoring).toEqual({
      maxScore: 120,
    });
  });

  it('rejects negative, zero, extra-decimal, string, and unknown scoring fields', () => {
    expect(() => parseCreateTestSeriesInput({ ...pdfBase, scoring: { maxScore: -1 } })).toThrow();
    expect(() => parseCreateTestSeriesInput({ ...pdfBase, scoring: { maxScore: 0 } })).toThrow();
    expect(() =>
      parseCreateTestSeriesInput({ ...pdfBase, scoring: { maxScore: 100.001 } }),
    ).toThrow();
    expect(() =>
      parseCreateTestSeriesInput({ ...pdfBase, scoring: { maxScore: '100' } }),
    ).toThrow();
    expect(() =>
      parseCreateTestSeriesInput({ ...pdfBase, scoring: { maxScore: 50, $gt: 1 } }),
    ).toThrow();
    expect(() =>
      parseCreateTestSeriesInput({
        ...pdfBase,
        scoring: { maxScore: 50, correctMarks: 4, incorrectMarks: -1, unansweredMarks: 0 },
      }),
    ).toThrow();
    expect(() => parseUpdateTestSeriesInput({ scoring: { maxScore: 0 } })).toThrow();
    expect(() => parseUpdateTestSeriesInput({ scoring: { unknown: 1 } })).toThrow();
  });
});
