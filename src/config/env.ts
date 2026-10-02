import 'dotenv/config';
import { z } from 'zod';

/** Treat "true" / "1" / "yes" as true, anything else falls back to the default. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? fallback : /^(true|1|yes)$/i.test(v)));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  API_PREFIX: z.string().default('/api/v1'),
  /** The only browser origins allowed to call the API (CORS + CSRF origin check). */
  SHOP_APP_URL: z.url().transform((u) => new URL(u).origin),
  ADMIN_APP_URL: z.url().transform((u) => new URL(u).origin),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),

  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  REFRESH_TTL_DAYS_REMEMBER: z.coerce.number().int().positive().default(90),
  // Cookies are host-only (no Domain attribute). `none` is not offered: CSRF defence relies on SameSite.
  COOKIE_SECURE: boolish(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict']).default('lax'),

  /** HMAC key for CSRF tokens. */
  CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters'),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  RATE_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  RATE_OTP_REQUEST_PER_EMAIL: z.coerce.number().int().positive().default(3),
  RATE_OTP_REQUEST_PER_IP: z.coerce.number().int().positive().default(60),
  RATE_OTP_VERIFY_PER_EMAIL: z.coerce.number().int().positive().default(15),
  RATE_REFRESH_PER_USER: z.coerce.number().int().positive().default(120),
  /** Default for protected API routes — per user, per minute. */
  RATE_API_PER_USER_PER_MIN: z.coerce.number().int().positive().default(300),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: boolish(false),
  /** The minute scheduler (mail queue, digests, nightly points); off for a second API process if wanted. */
  JOBS_ENABLED: boolish(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('Medicine Shop'),
  MAIL_FROM_EMAIL: z.string().default('no-reply@example.com'),
  /** Local login without reading the terminal: every OTP is this code. Refused outside development. */
  DEV_STATIC_OTP: z.string().optional().transform((v) => v || undefined),

  // Trial and Terms until the admin app owns them (B8 / B9)
  TRIAL_DAYS: z.coerce.number().int().positive().default(14),
  TRIAL_MAX_USERS: z.coerce.number().int().positive().default(3),
  TERMS_VERSION: z.string().default('2026-10'),

  /** Seals admin authenticator secrets; production must set its own (32+ characters). */
  ADMIN_TOTP_KEY: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .refine((v) => !v || v.length >= 32, 'needs 32+ characters'),
  /** off = no online payment; test = local orders and a test-pay button (never in production); razorpay = live. */
  PAYMENTS_MODE: z.enum(['off', 'test', 'razorpay']).default('off'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = schema
  .refine((e) => e.NODE_ENV !== 'production' || e.COOKIE_SECURE, {
    path: ['COOKIE_SECURE'],
    message: 'must be true in production',
  })
  .refine((e) => e.CSRF_SECRET !== e.JWT_ACCESS_SECRET, {
    path: ['CSRF_SECRET'],
    message: 'must differ from JWT_ACCESS_SECRET',
  })
  .refine((e) => e.NODE_ENV !== 'production' || Boolean(e.ADMIN_TOTP_KEY), { message: 'is required in production', path: ['ADMIN_TOTP_KEY'] })
  .refine((e) => !(e.NODE_ENV === 'production' && e.PAYMENTS_MODE === 'test'), { message: 'PAYMENTS_MODE=test is refused in production', path: ['PAYMENTS_MODE'] })
  .refine((e) => e.PAYMENTS_MODE !== 'razorpay' || Boolean(e.RAZORPAY_KEY_ID && e.RAZORPAY_KEY_SECRET && e.RAZORPAY_WEBHOOK_SECRET), { message: 'needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET', path: ['PAYMENTS_MODE'] })
  .refine((e) => !e.DEV_STATIC_OTP || e.NODE_ENV === 'development', {
    path: ['DEV_STATIC_OTP'],
    message: 'is allowed only with NODE_ENV=development — remove it',
  })
  .refine((e) => !e.DEV_STATIC_OTP || (/^\d+$/.test(e.DEV_STATIC_OTP) && e.DEV_STATIC_OTP.length === e.OTP_LENGTH), {
    path: ['DEV_STATIC_OTP'],
    message: 'must be OTP_LENGTH digits',
  })
  .safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  // The logger does not exist yet (it depends on env), so use console directly.
  console.error('\n❌ Invalid environment config:\n' + lines.join('\n'));
  console.error('\n   Copy `.env.example` to `.env` and fill in the values.\n');
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

/** SMTP is only usable when the host and both credentials are set. */
/** Browser origins allowed to make credentialed requests. */
export const allowedOrigins: readonly string[] = [env.SHOP_APP_URL, env.ADMIN_APP_URL];

export const isSmtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
