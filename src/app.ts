/**
 * Express app wiring. Middleware and route mounting only — business logic
 * lives in services, never in route handlers.
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { env, isDev } from './config/env';
import { logger } from './config/logger';
import { errorHandler, notFoundHandler } from './core/middleware/error-handler';
import { healthRouter } from './modules/health/health.routes';

export function createApp() {
  const app = express();

  // Behind a reverse proxy (Render/Railway/Nginx) this is what gives us the
  // real client IP. Without it both rate limiting and the audit log are wrong.
  app.set('trust proxy', 1);

  app.use(helmet());

  app.use(
    cors({
      origin(origin, callback) {
        // Mobile apps, curl and server-to-server calls send no Origin header.
        if (!origin) return callback(null, true);
        if (env.CORS_ORIGINS.length === 0 && isDev) return callback(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked: ${origin}`));
      },
      // The refresh token travels in an httpOnly cookie; without this the
      // browser will neither send nor store it.
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    pinoHttp({
      logger,
      // Logging every health check just fills the log with noise.
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === `${env.API_PREFIX}/health` },
    }),
  );

  // ─── Routes ───────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use(`${env.API_PREFIX}/health`, healthRouter);

  // TODO (Phase 1): auth routes
  // TODO (Phase 2): business, employees, roles

  // ─── Fallbacks ────────────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
