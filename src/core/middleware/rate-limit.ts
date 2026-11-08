import { rateLimit, ipKeyGenerator, type Options, type RateLimitInfo } from 'express-rate-limit';
import type { Request } from 'express';
import { readCookie } from '../cookies';
import { AppError } from '../errors';
import { SharedStore } from '../rate-store';
import { env } from '../../config/env';
import { signal } from '../../services/monitor';
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

/** Minutes until the window opens again, at least 1. */
const minutesLeft = (req: Request) => {
  const reset = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit?.resetTime;
  return Math.max(1, Math.ceil(((reset?.getTime() ?? Date.now() + WINDOW) - Date.now()) / ONE_MIN));
};

/** A sign-in code limit says when it opens again; many hits in a row alert the super admins. */
const codeLimited = (req: Request) => {
  void signal('code_limited');
  return minutesLeft(req);
};

/** `key` and `store` keep each sign-in's counters apart; the shop and partner ones stay as they always were. */
function codeLimiters(key: string, store: string) {
  return {
    // Per email; a code the mail server refused (503) does not use up the person's tries.
    byEmail: rateLimit({
      ...shared,
      windowMs: WINDOW,
      limit: env.RATE_OTP_REQUEST_PER_EMAIL,
      keyGenerator: (req) => `${key}-req:${emailOf(req) ?? ipKeyGenerator(req.ip ?? '')}`,
      // No email at all? Do not spend a bucket on it — validation will 422 anyway.
      skip: (req) => !emailOf(req),
      skipFailedRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== 503,
      handler: (req, _res, next) => {
        const min = codeLimited(req);
        next(AppError.rateLimited(`Too many codes asked for this email. Try again in ${String(min)} min.`));
      },
      store: new SharedStore(`${store}:`),
    }),
    // Per IP, purely to stop mass enumeration; every request counts, during a mail outage too.
    byIp: rateLimit({
      ...shared,
      windowMs: WINDOW,
      limit: env.RATE_OTP_REQUEST_PER_IP,
      keyGenerator: ipKey,
      handler: (req, _res, next) => {
        const min = codeLimited(req);
        next(AppError.rateLimited(`Too many sign-in codes asked from this network. Try again in ${String(min)} min.`));
      },
      store: new SharedStore(`${store}-${key}-ip:`),
    }),
    check: rateLimit({
      ...shared,
      windowMs: WINDOW,
      limit: env.RATE_OTP_VERIFY_PER_EMAIL,
      keyGenerator: (req) => `${key}-verify:${emailOf(req) ?? ipKeyGenerator(req.ip ?? '')}`,
      skip: (req) => !emailOf(req),
      handler: (req, _res, next) => {
        const min = minutesLeft(req);
        next(AppError.rateLimited(`Too many tries for this email. Try again in ${String(min)} min.`));
      },
      store: new SharedStore(`${store}:`),
    }),
  };
}

const shopCodes = codeLimiters('otp', 'rl');
export const otpRequestByEmailLimiter = shopCodes.byEmail;
export const otpRequestByIpLimiter = shopCodes.byIp;
export const otpVerifyLimiter = shopCodes.check;
export const adminCodeLimiters = codeLimiters('admin', 'rl-admin');

// Refresh — keyed by user when an access token is present, otherwise by IP.
export const refreshLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_REFRESH_PER_USER,
  keyGenerator: userKey,
  store: new SharedStore('rl-refresh:'),
});
