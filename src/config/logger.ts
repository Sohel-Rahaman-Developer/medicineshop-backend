/**
 * Pino logger.
 *
 * Dev me pretty output, production me JSON (log aggregator ke liye).
 * Sensitive fields hamesha redact hote hain — OTP, password, token kabhi
 * log me nahi jaana chahiye.
 */
import pino from 'pino';
import { env, isProd } from './env';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.otp',
      '*.password',
      '*.refreshToken',
      '*.accessToken',
      '*.SMTP_PASS',
      '*.RAZORPAY_KEY_SECRET',
    ],
    censor: '[redacted]',
  },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});
