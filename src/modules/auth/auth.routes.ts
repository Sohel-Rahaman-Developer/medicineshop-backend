import { Router } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { validate } from '../../core/middleware/validate';
import { optionalAuth, requireAuth } from '../../core/middleware/require-auth';
import {
  otpRequestByEmailLimiter,
  otpRequestByIpLimiter,
  otpVerifyLimiter,
  refreshLimiter,
} from '../../core/middleware/rate-limit';
import * as ctrl from './auth.controller';
import {
  emptyBodySchema,
  logoutSchema,
  requestOtpSchema,
  sessionIdSchema,
  updateMeSchema,
  verifyOtpSchema,
} from './auth.validation';

export const authRouter = Router();

// Hands the app its CSRF token (body + httpOnly cookie). GET, so CSRF itself does not apply.
authRouter.get('/csrf', ctrl.csrf);

authRouter.post(
  '/otp/request',
  otpRequestByIpLimiter,
  otpRequestByEmailLimiter,
  validate({ body: requestOtpSchema }),
  asyncHandler(ctrl.requestOtp),
);

authRouter.post(
  '/otp/verify',
  otpVerifyLimiter,
  validate({ body: verifyOtpSchema }),
  asyncHandler(ctrl.verifyOtp),
);

// optionalAuth runs BEFORE the limiter so the rate limit keys on userId rather than IP.
authRouter.post(
  '/refresh',
  optionalAuth,
  refreshLimiter,
  validate({ body: emptyBodySchema }),
  asyncHandler(ctrl.refresh),
);

// Logout must work with an expired access token, hence optionalAuth.
authRouter.post('/logout', optionalAuth, validate({ body: logoutSchema }), asyncHandler(ctrl.logout));

authRouter.get('/me', requireAuth, asyncHandler(ctrl.me));
authRouter.patch('/me', requireAuth, validate({ body: updateMeSchema }), asyncHandler(ctrl.updateMe));
authRouter.get('/sessions', requireAuth, asyncHandler(ctrl.sessions));
authRouter.delete(
  '/sessions/:id',
  requireAuth,
  validate({ params: sessionIdSchema }),
  asyncHandler(ctrl.revokeSession),
);
