import { rateLimit, ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../errors';
import { env } from '../../config/env';

const WINDOW = env.RATE_WINDOW_MINUTES * 60 * 1000;
const ONE_MIN = 60 * 1000;

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(AppError.rateLimited()),
};

/** The library helper is required to bucket IPv6 addresses correctly. */
const ipKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? '')}`;

const userKey = (req: Request) => (req.auth ? `user:${req.auth.userId}` : ipKey(req));

// Runs before validation, so the body is untrusted: only a string counts as an email.
const emailOf = (req: Request) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.toLowerCase().trim() : undefined;
};

export const perUser = (opts: { limit?: number; windowMs?: number } = {}) =>
  rateLimit({
    ...shared,
    windowMs: opts.windowMs ?? ONE_MIN,
    limit: opts.limit ?? env.RATE_API_PER_USER_PER_MIN,
    keyGenerator: userKey,
  });

// Requesting an OTP — keyed by EMAIL.
export const otpRequestByEmailLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_REQUEST_PER_EMAIL,
  keyGenerator: (req) => `otp-req:${emailOf(req) ?? ipKeyGenerator(req.ip ?? '')}`,
  // No email at all? Do not spend a bucket on it — validation will 422 anyway.
  skip: (req) => !emailOf(req),
});

// Requesting an OTP — keyed by IP, purely to stop mass enumeration.
export const otpRequestByIpLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_REQUEST_PER_IP,
  keyGenerator: ipKey,
});

// Verifying an OTP — keyed by email.
export const otpVerifyLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_VERIFY_PER_EMAIL,
  keyGenerator: (req) => `otp-verify:${emailOf(req) ?? ipKeyGenerator(req.ip ?? '')}`,
  skip: (req) => !emailOf(req),
});

// Refresh — keyed by user when an access token is present, otherwise by IP.
export const refreshLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_REFRESH_PER_USER,
  keyGenerator: userKey,
});
