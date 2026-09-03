import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../../database/models/conventions';

export const NOTIFICATION_IDENTIFIERS = [
  'PASSWORD_RESET_REQUESTED',
  'PURCHASE_SUCCESSFUL',
  'ATTEMPT_SUBMITTED',
  'RESULT_PUBLISHED',
  'EVALUATION_ASSIGNED',
] as const;

export type NotificationIdentifier = (typeof NOTIFICATION_IDENTIFIERS)[number];

export type NotificationPayloadMap = {
  PASSWORD_RESET_REQUESTED: {
    resetUrl: string;
    expiresInMinutes: number;
  };
  PURCHASE_SUCCESSFUL: {
    testSeriesTitle: string;
    amountLabel: string;
    accessDays?: number;
  };
  ATTEMPT_SUBMITTED: {
    testSeriesTitle: string;
    submittedAt: string;
  };
  RESULT_PUBLISHED: {
    testSeriesTitle: string;
    score: number;
    maxScore: number;
    percentage: number;
  };
  EVALUATION_ASSIGNED: {
    testSeriesTitle: string;
    categoryName: string;
  };
};

export type RenderedNotificationEmail = {
  identifier: NotificationIdentifier;
  subject: string;
  text: string;
  html: string;
};

export function formatPurchaseAmount(amountPaise: number, currency: string): string {
  return `${currency} ${(amountPaise / 100).toFixed(2)}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function paragraphsToHtml(paragraphs: string[]): string {
  return paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('');
}

export function renderNotificationEmail<T extends NotificationIdentifier>(
  identifier: T,
  payload: NotificationPayloadMap[T],
): RenderedNotificationEmail {
  switch (identifier) {
    case 'PASSWORD_RESET_REQUESTED': {
      const { resetUrl, expiresInMinutes } =
        payload as NotificationPayloadMap['PASSWORD_RESET_REQUESTED'];
      return {
        identifier,
        subject: 'Reset your Xplooreze password',
        text: [
          'We received a request to reset your Xplooreze password.',
          '',
          `Use the link below to reset your password. This link expires in ${expiresInMinutes} minutes.`,
          resetUrl,
          '',
          'If you did not request a password reset, you can ignore this email.',
        ].join('\n'),
        html: [
          '<p>We received a request to reset your Xplooreze password.</p>',
          `<p>Use the link below to reset your password. This link expires in ${expiresInMinutes} minutes.</p>`,
          `<p><a href="${resetUrl}">Reset password</a></p>`,
          '<p>If you did not request a password reset, you can ignore this email.</p>',
        ].join(''),
      };
    }
    case 'PURCHASE_SUCCESSFUL': {
      const {
        testSeriesTitle,
        amountLabel,
        accessDays = PAID_ENTITLEMENT_VALIDITY_DAYS,
      } = payload as NotificationPayloadMap['PURCHASE_SUCCESSFUL'];
      const title = escapeHtml(testSeriesTitle);
      return {
        identifier,
        subject: 'Your Xplooreze purchase is confirmed',
        text: [
          `Your purchase of ${testSeriesTitle} is confirmed.`,
          `Amount: ${amountLabel}.`,
          `Access is now available for ${accessDays} days.`,
        ].join('\n'),
        html: paragraphsToHtml([
          `Your purchase of ${title} is confirmed.`,
          `Amount: ${escapeHtml(amountLabel)}.`,
          `Access is now available for ${accessDays} days.`,
        ]),
      };
    }
    case 'ATTEMPT_SUBMITTED': {
      const { testSeriesTitle, submittedAt } =
        payload as NotificationPayloadMap['ATTEMPT_SUBMITTED'];
      const title = escapeHtml(testSeriesTitle);
      return {
        identifier,
        subject: 'Your Xplooreze attempt has been submitted',
        text: [
          `Your attempt for ${testSeriesTitle} has been submitted.`,
          `Submitted at: ${submittedAt}.`,
        ].join('\n'),
        html: paragraphsToHtml([
          `Your attempt for ${title} has been submitted.`,
          `Submitted at: ${escapeHtml(submittedAt)}.`,
        ]),
      };
    }
    case 'RESULT_PUBLISHED': {
      const { testSeriesTitle, score, maxScore, percentage } =
        payload as NotificationPayloadMap['RESULT_PUBLISHED'];
      const title = escapeHtml(testSeriesTitle);
      return {
        identifier,
        subject: 'Your Xplooreze result is available',
        text: [
          `Your result for ${testSeriesTitle} is now available.`,
          `Score: ${score} / ${maxScore} (${percentage}%).`,
        ].join('\n'),
        html: paragraphsToHtml([
          `Your result for ${title} is now available.`,
          `Score: ${score} / ${maxScore} (${percentage}%).`,
        ]),
      };
    }
    case 'EVALUATION_ASSIGNED': {
      const { testSeriesTitle, categoryName } =
        payload as NotificationPayloadMap['EVALUATION_ASSIGNED'];
      const title = escapeHtml(testSeriesTitle);
      const category = escapeHtml(categoryName);
      return {
        identifier,
        subject: 'A Xplooreze evaluation has been assigned to you',
        text: [
          `You have been assigned to evaluate ${testSeriesTitle}.`,
          `Category: ${categoryName}.`,
        ].join('\n'),
        html: paragraphsToHtml([
          `You have been assigned to evaluate ${title}.`,
          `Category: ${category}.`,
        ]),
      };
    }
    default: {
      const exhaustive: never = identifier;
      throw new Error(`Unsupported notification identifier: ${String(exhaustive)}`);
    }
  }
}
