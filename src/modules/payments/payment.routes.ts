import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireStudent } from '../../middleware/require-role';
import { razorpayWebhookController, verifyPaymentController } from './payment.controller';

export const paymentRouter = Router();
export const razorpayWebhookRouter = Router();

paymentRouter.post('/verify', authenticate, requireStudent, verifyPaymentController);
razorpayWebhookRouter.post('/', razorpayWebhookController);
