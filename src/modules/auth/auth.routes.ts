/**
 * Auth routes.
 *
 * Middleware order matters:
 *   rate limit → validate → controller
 * Rate limiting comes first so that a flood never reaches validation or the
 * database at all.
 */
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
  logoutSchema,
  refreshSchema,
  requestOtpSchema,
  sessionIdSchema,
  verifyOtpSchema,
} from './auth.validation';

export const authRouter = Router();

/* ── Public ─────────────────────────────────────────────────────────── */

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

// optionalAuth runs BEFORE the limiter so the rate limit keys on userId rather
// than IP. A well-behaved client refreshes proactively, before the access token
// expires, and gets its own per-user bucket. A client that refreshes after
// expiry falls back to IP, which is safe on shared connections because that
// limit is deliberately loose.
authRouter.post(
  '/refresh',
  optionalAuth,
  refreshLimiter,
  validate({ body: refreshSchema }),
  asyncHandler(ctrl.refresh),
);

// The access token may already be expired at logout. Logout must still work
// using the refresh token, hence optionalAuth rather than requireAuth.
authRouter.post('/logout', optionalAuth, validate({ body: logoutSchema }), asyncHandler(ctrl.logout));

/* ── Protected ──────────────────────────────────────────────────────── */

authRouter.get('/me', requireAuth, asyncHandler(ctrl.me));
authRouter.get('/sessions', requireAuth, asyncHandler(ctrl.sessions));
authRouter.delete(
  '/sessions/:id',
  requireAuth,
  validate({ params: sessionIdSchema }),
  asyncHandler(ctrl.revokeSession),
);
