import { PAID_ENTITLEMENT_VALIDITY_DAYS } from '../../database/models/conventions';
import {
  categoryRepository,
  testSeriesRepository,
  userRepository,
} from '../../database/repositories/index';
import { AppError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger/logger';
import { sendEmail } from './email.service';
import {
  formatPurchaseAmount,
  renderNotificationEmail,
  type NotificationIdentifier,
  type NotificationPayloadMap,
} from './email-templates';

const FALLBACK_TEST_SERIES_TITLE = 'your test series';
const FALLBACK_CATEGORY_NAME = 'your category';

function recipientDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1) : 'unknown';
}

async function resolveUserEmail(userId: string): Promise<string | null> {
  const user = await userRepository.findById(userId);
  if (!user || user.deletedAt != null || !user.email) {
    return null;
  }

  return user.email;
}

async function resolveTestSeriesTitle(testSeriesId: string): Promise<string> {
  const testSeries = await testSeriesRepository.findById(testSeriesId);
  const title = testSeries?.title?.trim();
  return title && title.length > 0 ? title : FALLBACK_TEST_SERIES_TITLE;
}

async function resolveCategoryName(categoryId: string): Promise<string> {
  const category = await categoryRepository.findById(categoryId);
  const name = category?.name?.trim();
  return name && name.length > 0 ? name : FALLBACK_CATEGORY_NAME;
}

export async function deliverNotification<T extends NotificationIdentifier>(input: {
  identifier: T;
  to: string;
  payload: NotificationPayloadMap[T];
  resourceId?: string;
}): Promise<void> {
  const rendered = renderNotificationEmail(input.identifier, input.payload);
  const logger = getLogger({
    module: 'notifications',
    notificationType: input.identifier,
  });

  try {
    await sendEmail({
      to: input.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    logger.info(
      {
        event: 'NOTIFICATION_DELIVERED',
        notificationType: input.identifier,
        recipientDomain: recipientDomain(input.to),
        resourceId: input.resourceId,
      },
      'Transactional email delivered',
    );
  } catch (error) {
    logger.error(
      {
        event: 'NOTIFICATION_DELIVERY_FAILED',
        notificationType: input.identifier,
        recipientDomain: recipientDomain(input.to),
        resourceId: input.resourceId,
        errorCode: error instanceof AppError ? error.code : undefined,
      },
      'Transactional email delivery failed',
    );
  }
}

export async function notifyPurchaseSuccessful(input: {
  studentId: string;
  testSeriesId: string;
  purchaseId: string;
  amount: number;
  currency: string;
}): Promise<void> {
  const to = await resolveUserEmail(input.studentId);
  if (!to) {
    getLogger({ module: 'notifications', notificationType: 'PURCHASE_SUCCESSFUL' }).error(
      {
        event: 'NOTIFICATION_DELIVERY_FAILED',
        notificationType: 'PURCHASE_SUCCESSFUL',
        resourceId: input.purchaseId,
      },
      'Purchase success email skipped because the student email could not be resolved',
    );
    return;
  }

  await deliverNotification({
    identifier: 'PURCHASE_SUCCESSFUL',
    to,
    resourceId: input.purchaseId,
    payload: {
      testSeriesTitle: await resolveTestSeriesTitle(input.testSeriesId),
      amountLabel: formatPurchaseAmount(input.amount, input.currency),
      accessDays: PAID_ENTITLEMENT_VALIDITY_DAYS,
    },
  });
}

export async function notifyAttemptSubmitted(input: {
  studentId: string;
  testSeriesId: string;
  attemptId: string;
  submittedAt: Date;
}): Promise<void> {
  const to = await resolveUserEmail(input.studentId);
  if (!to) {
    getLogger({ module: 'notifications', notificationType: 'ATTEMPT_SUBMITTED' }).error(
      {
        event: 'NOTIFICATION_DELIVERY_FAILED',
        notificationType: 'ATTEMPT_SUBMITTED',
        resourceId: input.attemptId,
      },
      'Attempt submitted email skipped because the student email could not be resolved',
    );
    return;
  }

  await deliverNotification({
    identifier: 'ATTEMPT_SUBMITTED',
    to,
    resourceId: input.attemptId,
    payload: {
      testSeriesTitle: await resolveTestSeriesTitle(input.testSeriesId),
      submittedAt: input.submittedAt.toISOString(),
    },
  });
}

export async function notifyResultPublished(input: {
  studentId: string;
  testSeriesId: string;
  resultId: string;
  score: number;
  maxScore: number;
  percentage: number;
}): Promise<void> {
  const to = await resolveUserEmail(input.studentId);
  if (!to) {
    getLogger({ module: 'notifications', notificationType: 'RESULT_PUBLISHED' }).error(
      {
        event: 'NOTIFICATION_DELIVERY_FAILED',
        notificationType: 'RESULT_PUBLISHED',
        resourceId: input.resultId,
      },
      'Result published email skipped because the student email could not be resolved',
    );
    return;
  }

  await deliverNotification({
    identifier: 'RESULT_PUBLISHED',
    to,
    resourceId: input.resultId,
    payload: {
      testSeriesTitle: await resolveTestSeriesTitle(input.testSeriesId),
      score: input.score,
      maxScore: input.maxScore,
      percentage: input.percentage,
    },
  });
}

export async function notifyEvaluationAssigned(input: {
  evaluatorId: string;
  testSeriesId: string;
  categoryId: string;
  evaluationId: string;
}): Promise<void> {
  const to = await resolveUserEmail(input.evaluatorId);
  if (!to) {
    getLogger({ module: 'notifications', notificationType: 'EVALUATION_ASSIGNED' }).error(
      {
        event: 'NOTIFICATION_DELIVERY_FAILED',
        notificationType: 'EVALUATION_ASSIGNED',
        resourceId: input.evaluationId,
      },
      'Evaluation assigned email skipped because the evaluator email could not be resolved',
    );
    return;
  }

  await deliverNotification({
    identifier: 'EVALUATION_ASSIGNED',
    to,
    resourceId: input.evaluationId,
    payload: {
      testSeriesTitle: await resolveTestSeriesTitle(input.testSeriesId),
      categoryName: await resolveCategoryName(input.categoryId),
    },
  });
}
