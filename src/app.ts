import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { allowedOrigins, env, isProd } from './config/env';
import { logger } from './config/logger';
import { csrfProtection } from './core/middleware/csrf';
import { errorHandler, notFoundHandler } from './core/middleware/error-handler';
import { healthRouter } from './modules/health/health.routes';
import { authRouter } from './modules/auth/auth.routes';

export function createApp() {
  const app = express();

  // Real client IP behind the proxy — rate limits and audit depend on it.
  app.set('trust proxy', 1);

  // The API only ever returns JSON, so the CSP can forbid everything.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      strictTransportSecurity: isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // Only our own apps get CORS headers; any other origin gets none and the browser blocks it.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, origin !== undefined && allowedOrigins.includes(origin)),
      // Auth rides in httpOnly cookies; without this the browser neither sends nor stores them.
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Every API response is private to the signed-in user — no shared or browser caching.
  app.use(env.API_PREFIX, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(env.API_PREFIX, csrfProtection);

  app.use(
    pinoHttp({
      logger,
      // Logging every health check just fills the log with noise.
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === `${env.API_PREFIX}/health` },
    }),
  );

  app.use('/health', healthRouter);
  app.use(`${env.API_PREFIX}/health`, healthRouter);
  app.use(`${env.API_PREFIX}/auth`, authRouter);

  // B1: shops, memberships, roles, staff

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
