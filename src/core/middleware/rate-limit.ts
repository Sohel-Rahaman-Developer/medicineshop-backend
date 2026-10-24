import { rateLimit, ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { readCookie } from '../cookies';
import { AppError } from '../errors';
import { SharedStore } from '../rate-store';
import { env } from '../../config/env';
import { ACCESS_COOKIE } from '../../modules/auth/auth.cookies';
import { verifyAccessToken } from '../../modules/auth/token.service';

// Every limit is a time window that opens again by itself — nobody, and no IP, is ever blocked for good.
const WINDOW = env.RATE_WINDOW_MINUTES * 60 * 1000;
const ONE_MIN = 60 * 1000;

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(AppError.rateLimited()),
  // A database hiccup must not lock people out: the request goes through.
  passOnStoreError: true,
};

/** A memory store counts per worker; with the traffic spread evenly, each worker takes its share of the limit. */
export const perWorker = (limit: number) => Math.max(1, Math.ceil(limit / env.API_WORKERS));

/** The library helper is required to bucket IPv6 addresses correctly. */
const ipKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? '')}`;

const userKey = (req: Request) => (req.auth ? `user:${req.auth.userId}` : ipKey(req));

/** Before any route: the signed-in user from the access cookie (verified, not trusted), else the IP. */
const cookieUserKey = (req: Request) => {
  const token = readCookie(req, ACCESS_COOKIE);
  if (token) {
    try {
      return `user:${verifyAccessToken(token).sub}`;
    } catch {
      // A bad or expired token counts against the IP, like no token.
    }
  }
  return ipKey(req);
};

// Runs before validation, so the body is untrusted: only a string counts as an email.
const emailOf = (req: Request) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.toLowerCase().trim() : undefined;
};

/** Per signed-in person; `name` gives the limit its own counter shared by every worker (AI questions cost money). */
export const perUser = (opts: { limit?: number; windowMs?: number; name?: string } = {}) =>
  rateLimit({
    ...shared,
    windowMs: opts.windowMs ?? ONE_MIN,
    limit: opts.name ? (opts.limit ?? env.RATE_API_PER_USER_PER_MIN) : perWorker(opts.limit ?? env.RATE_API_PER_USER_PER_MIN),
    keyGenerator: userKey,
    ...(opts.name ? { store: new SharedStore(`${opts.name}:`) } : {}),
  });

/** Every API call: per person (or IP when signed out), a minute at a time. */
export const apiLimiter = rateLimit({
  ...shared,
  windowMs: ONE_MIN,
  limit: perWorker(env.RATE_API_PER_USER_PER_MIN),
  keyGenerator: cookieUserKey,
});

/** PDFs and Excel files take real work to build: fewer of them a minute. */
export const fileLimiter = rateLimit({
  ...shared,
  windowMs: ONE_MIN,
  limit: perWorker(env.RATE_FILES_PER_USER_PER_MIN),
  keyGenerator: (req) => `file:${cookieUserKey(req)}`,
  handler: (_req, _res, next) => next(AppError.rateLimited('Too many downloads at once. Wait a minute and try again.')),
});

// Requesting an OTP — keyed by EMAIL.
export const otpRequestByEmailLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_REQUEST_PER_EMAIL,
  keyGenerator: (req) => `otp-req:${emailOf(req) ?? ipKeyGenerator(req.ip ?? '')}`,
  // No email at all? Do not spend a bucket on it — validation will 422 anyway.
  skip: (req) => !emailOf(req),
  store: new SharedStore('rl:'),
});

// Requesting an OTP — keyed by IP, purely to stop mass enumeration.
export const otpRequestByIpLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_REQUEST_PER_IP,
  keyGenerator: ipKey,
  store: new SharedStore('rl-otp-ip:'),
});

// Verifying an OTP — keyed by email.
export const otpVerifyLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_VERIFY_PER_EMAIL,
  keyGenerator: (req) => `otp-verify:${emailOf(req) ?? ipKeyGenerator(req.ip ?? '')}`,
  skip: (req) => !emailOf(req),
  store: new SharedStore('rl:'),
});

// Refresh — keyed by user when an access token is present, otherwise by IP.
export const refreshLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_REFRESH_PER_USER,
  keyGenerator: userKey,
  store: new SharedStore('rl-refresh:'),
});
