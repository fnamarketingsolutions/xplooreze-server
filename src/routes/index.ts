import { Router } from 'express';

import { adminAnalyticsRouter } from '../modules/analytics/analytics.routes';
import { attemptRouter } from '../modules/attempts/attempt.routes';
import { authRouter } from '../modules/auth/auth.routes';
import { adminCategoryRouter, categoryRouter } from '../modules/categories/category.routes';
import { adminEvaluatorAssignmentRouter } from '../modules/evaluator-assignments/evaluator-assignment.routes';
import { adminEntitlementRouter } from '../modules/entitlements/entitlement.routes';
import { adminEvaluationRouter, evaluationRouter } from '../modules/evaluations/evaluation.routes';
import { adminAnswerFileRouter, fileRouter } from '../modules/files/file.routes';
import { healthRouter, readyRouter } from '../modules/health/health.routes';
import { meRouter } from '../modules/me/me.routes';
import { adminModuleRouter, moduleRouter } from '../modules/modules/module.routes';
import { paymentRouter } from '../modules/payments/payment.routes';
import { adminPurchaseRouter, purchaseRouter } from '../modules/purchases/purchase.routes';
import { adminQuestionRouter } from '../modules/questions/question.routes';
import { adminResultRouter } from '../modules/results/result.routes';
import { adminTestSeriesRouter, testSeriesRouter } from '../modules/test-series/test-series.routes';
import { adminUserRouter } from '../modules/users/user.routes';

const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/ready', readyRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/categories', categoryRouter);
apiRouter.use('/modules', moduleRouter);
apiRouter.use('/test-series', testSeriesRouter);
apiRouter.use('/purchases', purchaseRouter);
apiRouter.use('/payments', paymentRouter);
apiRouter.use('/attempts', attemptRouter);
apiRouter.use('/files', fileRouter);
apiRouter.use('/evaluator/evaluations', evaluationRouter);
apiRouter.use('/admin/users', adminUserRouter);
apiRouter.use('/admin/evaluator-category-assignments', adminEvaluatorAssignmentRouter);
apiRouter.use('/admin/categories', adminCategoryRouter);
apiRouter.use('/admin/modules', adminModuleRouter);
apiRouter.use('/admin/test-series', adminTestSeriesRouter);
apiRouter.use('/admin/answer-files', adminAnswerFileRouter);
apiRouter.use('/admin/questions', adminQuestionRouter);
apiRouter.use('/admin/purchases', adminPurchaseRouter);
apiRouter.use('/admin/entitlements', adminEntitlementRouter);
apiRouter.use('/admin/evaluations', adminEvaluationRouter);
apiRouter.use('/admin/results', adminResultRouter);
apiRouter.use('/admin/analytics', adminAnalyticsRouter);

export { apiRouter };
