import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { COLLECTIONS } from '../src/database/models/enums';
import {
  NOTIFICATION_IDENTIFIERS,
  escapeHtml,
  formatPurchaseAmount,
  renderNotificationEmail,
} from '../src/modules/notifications/email-templates';

const SRC_ROOT = path.resolve(__dirname, '../src');

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...walkTsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }

  return files;
}

describe('Phase 24 email templates', () => {
  it('locks exactly five notification identifiers', () => {
    expect(NOTIFICATION_IDENTIFIERS).toEqual([
      'PASSWORD_RESET_REQUESTED',
      'PURCHASE_SUCCESSFUL',
      'ATTEMPT_SUBMITTED',
      'RESULT_PUBLISHED',
      'EVALUATION_ASSIGNED',
    ]);
  });

  it('renders PASSWORD_RESET_REQUESTED with the Phase 16 reset link and without the raw password', () => {
    const rendered = renderNotificationEmail('PASSWORD_RESET_REQUESTED', {
      resetUrl: 'http://localhost:5173/reset-password?token=reset-token-value',
      expiresInMinutes: 30,
    });

    expect(rendered.identifier).toBe('PASSWORD_RESET_REQUESTED');
    expect(rendered.subject).toBe('Reset your Xplooreze password');
    expect(rendered.text).toContain('http://localhost:5173/reset-password?token=reset-token-value');
    expect(rendered.text).toContain('30 minutes');
    expect(rendered.html).toContain('Reset password');
    expect(`${rendered.subject}\n${rendered.text}\n${rendered.html}`).not.toMatch(/password12/i);
    expect(rendered.text).not.toContain('smtp');
  });

  it('renders PURCHASE_SUCCESSFUL with student-facing purchase details and no payment secrets', () => {
    const rendered = renderNotificationEmail('PURCHASE_SUCCESSFUL', {
      testSeriesTitle: 'PDF Series',
      amountLabel: formatPurchaseAmount(49900, 'INR'),
      accessDays: 60,
    });

    expect(rendered.identifier).toBe('PURCHASE_SUCCESSFUL');
    expect(rendered.subject).toBe('Your Xplooreze purchase is confirmed');
    expect(rendered.text).toContain('PDF Series');
    expect(rendered.text).toContain('INR 499.00');
    expect(rendered.text).toContain('60 days');
    expect(rendered.text).not.toContain('razorpay');
    expect(rendered.text).not.toContain('signature');
    expect(rendered.html).toContain(escapeHtml('PDF Series'));
  });

  it('renders ATTEMPT_SUBMITTED without answers, editor content, or blob URLs', () => {
    const rendered = renderNotificationEmail('ATTEMPT_SUBMITTED', {
      testSeriesTitle: 'Editor Series',
      submittedAt: '2026-08-18T12:00:00.000Z',
    });

    expect(rendered.identifier).toBe('ATTEMPT_SUBMITTED');
    expect(rendered.subject).toBe('Your Xplooreze attempt has been submitted');
    expect(rendered.text).toContain('Editor Series');
    expect(rendered.text).toContain('2026-08-18T12:00:00.000Z');
    expect(rendered.text).not.toContain('selectedOptionId');
    expect(rendered.text).not.toContain('blob.vercel');
    expect(rendered.html).not.toContain('<script>');
  });

  it('renders RESULT_PUBLISHED from finalized Result fields without evaluator internals', () => {
    const rendered = renderNotificationEmail('RESULT_PUBLISHED', {
      testSeriesTitle: 'MCQ Series',
      score: 8,
      maxScore: 12,
      percentage: 66.67,
    });

    expect(rendered.identifier).toBe('RESULT_PUBLISHED');
    expect(rendered.subject).toBe('Your Xplooreze result is available');
    expect(rendered.text).toContain('8 / 12');
    expect(rendered.text).toContain('66.67%');
    expect(rendered.text).not.toContain('evaluator');
    expect(rendered.text).not.toContain('IN_PROGRESS');
  });

  it('renders EVALUATION_ASSIGNED without student private data or a fake frontend URL', () => {
    const rendered = renderNotificationEmail('EVALUATION_ASSIGNED', {
      testSeriesTitle: 'PDF Series',
      categoryName: 'Mathematics',
    });

    expect(rendered.identifier).toBe('EVALUATION_ASSIGNED');
    expect(rendered.subject).toBe('A Xplooreze evaluation has been assigned to you');
    expect(rendered.text).toContain('PDF Series');
    expect(rendered.text).toContain('Mathematics');
    expect(rendered.text).not.toContain('student@');
    expect(rendered.text).not.toContain('http://');
    expect(rendered.html).not.toContain('href=');
  });

  it('escapes HTML in template interpolation', () => {
    const rendered = renderNotificationEmail('PURCHASE_SUCCESSFUL', {
      testSeriesTitle: '<script>alert(1)</script>',
      amountLabel: 'INR 1.00',
    });

    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('Phase 24 static boundaries', () => {
  it('does not define a notifications MongoDB collection', () => {
    expect(Object.values(COLLECTIONS)).not.toContain('notifications');
    expect('notifications' in COLLECTIONS).toBe(false);
  });

  it('imports nodemailer only from the Email Client', () => {
    const offenders = walkTsFiles(SRC_ROOT).filter((file) => {
      if (file.endsWith(`${path.sep}email.client.ts`)) {
        return false;
      }

      const source = readFileSync(file, 'utf8');
      return /from ['"]nodemailer['"]/.test(source) || /require\(['"]nodemailer['"]\)/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it('does not introduce a notification worker, queue, or outbox', () => {
    const files = walkTsFiles(SRC_ROOT);
    const hits = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const matched: string[] = [];
      if (/\boutbox\b/i.test(source) && file.includes(`${path.sep}notifications${path.sep}`)) {
        matched.push(`${file}: outbox`);
      }
      if (/bullmq|bee-queue|agenda|kafkajs|ioredis.*job/i.test(source)) {
        matched.push(`${file}: queue`);
      }
      return matched;
    });

    expect(hits).toEqual([]);
  });
});
