/**
 * Rate limiters.
 *
 * ══ THE MOST IMPORTANT RULE ═════════════════════════════════════════
 *
 * No limiter is ever GLOBAL. We never build something that counts "1000
 * requests per minute across the whole app" — one person flooding it would
 * lock out every other shop. Every limiter has its own key:
 *
 *   authenticated route  → userId          (most accurate)
 *   OTP route            → email           (protects the victim's inbox)
 *   anonymous fallback   → IP              (and deliberately loose, see below)
 *
 * ══ WHY IP LIMITS ARE DELIBERATELY LOOSE ════════════════════════════
 *
 * Sharing an IP address is normal in India:
 *   - one shop runs 5 billing terminals behind a single router → one public IP
 *   - mobile data goes through carrier CGNAT → thousands of people on one IP
 *   - the shop WiFi is shared with staff phones
 *
 * So a strict per-IP limit means one person exhausts the budget and everyone
 * else in that shop — or on that ISP — is locked out too. IP limits exist only
 * to stop crude floods. The real protection comes from the per-email and
 * per-user limits, and from the OTP attempts counter.
 *
 * ⚠️ SCALING NOTE: the default store is in-memory, so counters are per process.
 * Fine for a single server. The moment we run 2+ instances or PM2 cluster mode,
 * `rate-limit-redis` becomes mandatory (the change is confined to this file).
 */
import { rateLimit, ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../errors';
import { env } from '../../config/env';

/** All limits and the window come from `.env` so they can be tuned in production. */
const WINDOW = env.RATE_WINDOW_MINUTES * 60 * 1000;
const ONE_MIN = 60 * 1000;

/** Every limiter returns the same error shape as the rest of the API. */
const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(AppError.rateLimited()),
};

/** The library helper is required to bucket IPv6 addresses correctly. */
const ipKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? '')}`;

/**
 * Key for authenticated routes: userId.
 *
 * This keeps a shop's 5 terminals from affecting each other — every user has
 * their own budget. Without a login we fall back to IP (with a loose limit).
 *
 * For this to work, `optionalAuth`/`requireAuth` must run BEFORE the limiter,
 * otherwise `req.auth` is not set yet.
 */
const userKey = (req: Request) => (req.auth ? `user:${req.auth.userId}` : ipKey(req));

const emailOf = (req: Request) => (req.body as { email?: string } | undefined)?.email?.toLowerCase().trim();

/* ────────────────────────────────────────────────────────────────────
 * Reusable factory — every protected route from Phase 2 onwards uses this
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Per-user limiter. Each feature picks its own limit:
 *
 *   router.get('/products', requireAuth, perUser({ limit: 300 }), ctrl.list)
 *   router.post('/sales',   requireAuth, perUser({ limit: 120 }), ctrl.createSale)
 *
 * One user hitting their limit has no effect on anybody else.
 */
export const perUser = (opts: { limit?: number; windowMs?: number } = {}) =>
  rateLimit({
    ...shared,
    windowMs: opts.windowMs ?? ONE_MIN,
    limit: opts.limit ?? env.RATE_API_PER_USER_PER_MIN,
    keyGenerator: userKey,
  });

/* ────────────────────────────────────────────────────────────────────
 * Auth routes
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Requesting an OTP — keyed by EMAIL. This is the real defence.
 *
 * Its job is to protect the owner of that address: nobody should be able to
 * rain OTPs into someone's inbox (mail bombing). Because the key is the email,
 * one address hitting the limit has no effect on any other user.
 */
export const otpRequestByEmailLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_REQUEST_PER_EMAIL,
  keyGenerator: (req) => `otp-req:${emailOf(req) ?? ipKeyGenerator(req.ip ?? '')}`,
  // No email at all? Do not spend a bucket on it — validation will 422 anyway.
  skip: (req) => !emailOf(req),
});

/**
 * Requesting an OTP — keyed by IP, purely to stop mass enumeration.
 *
 * Deliberately loose (`RATE_OTP_REQUEST_PER_IP`). A shop's whole staff, or
 * people behind CGNAT, will never hit it. An attacker spraying many different
 * email addresses will.
 */
export const otpRequestByIpLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_REQUEST_PER_IP,
  keyGenerator: ipKey,
});

/**
 * Verifying an OTP — keyed by email.
 *
 * This is the SECOND wall against brute force. The first is the OtpToken
 * `attempts` counter (5 wrong guesses kills the code immediately). This
 * limiter stops the trick of repeatedly requesting a fresh OTP and guessing.
 */
export const otpVerifyLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_OTP_VERIFY_PER_EMAIL,
  keyGenerator: (req) => `otp-verify:${emailOf(req) ?? ipKeyGenerator(req.ip ?? '')}`,
  skip: (req) => !emailOf(req),
});

/**
 * Refresh — keyed by user when an access token is present, otherwise by IP.
 *
 * Every device legitimately refreshes on the `JWT_ACCESS_TTL` cadence, so the
 * limit is loose. The refresh token itself is 256 bits of randomness — it
 * cannot be guessed, and a wrong or reused token revokes the whole family
 * immediately. The real protection is cryptographic; this limiter only stops a
 * runaway retry loop from hammering the database.
 */
export const refreshLimiter = rateLimit({
  ...shared,
  windowMs: WINDOW,
  limit: env.RATE_REFRESH_PER_USER,
  keyGenerator: userKey,
});
