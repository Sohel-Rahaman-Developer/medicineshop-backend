/**
 * Environment loading + validation.
 *
 * Every env var comes from here. Never read `process.env.X` directly —
 * import { env } from '@/config/env' instead. This way bad or missing config
 * is caught at boot, not at runtime in the middle of a sale.
 */
import 'dotenv/config';
import { z } from 'zod';

/** Treat "true" / "1" / "yes" as true, anything else falls back to the default. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? fallback : /^(true|1|yes)$/i.test(v)));

/** Turn a comma-separated list into a trimmed array. */
const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  API_PREFIX: z.string().default('/api/v1'),
  APP_WEB_URL: z.string().default('http://localhost:8081'),
  CORS_ORIGINS: csv,

  // Database
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // Access token
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),

  // Refresh token
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  REFRESH_TTL_DAYS_REMEMBER: z.coerce.number().int().positive().default(90),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: boolish(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // OTP
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  // SMTP
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: boolish(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('Medicine Shop'),
  MAIL_FROM_EMAIL: z.string().default('no-reply@example.com'),

  // Razorpay (Phase 9 — optional for now)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = schema.safeParse(process.env);

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
export const isSmtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
