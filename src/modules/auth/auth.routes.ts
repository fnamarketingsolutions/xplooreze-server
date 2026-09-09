import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireTrustedOrigin } from '../../middleware/trusted-origin';
import {
  forgotPasswordController,
  loginController,
  logoutController,
  meController,
  refreshController,
  registerController,
  resetPasswordController,
  updateMeController,
} from './auth.controller';

export const authRouter = Router();

authRouter.post('/register', registerController);
authRouter.post('/login', loginController);
authRouter.post('/forgot-password', forgotPasswordController);
authRouter.post('/reset-password', resetPasswordController);
authRouter.post('/refresh', requireTrustedOrigin, refreshController);
authRouter.post('/logout', requireTrustedOrigin, logoutController);
authRouter.get('/me', authenticate, meController);
authRouter.patch('/me', authenticate, updateMeController);
