/**
 * Express app wiring. Yahan sirf middleware + route mounting hota hai —
 * business logic services me rehta hai, route handlers me nahi.
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

  // Reverse proxy (Render/Railway/Nginx) ke peeche sahi client IP mile —
  // rate limiting aur audit log dono iske bina galat honge.
  app.set('trust proxy', 1);

  app.use(helmet());

  app.use(
    cors({
      origin(origin, callback) {
        // Mobile app / curl / server-to-server me Origin header hota hi nahi.
        if (!origin) return callback(null, true);
        if (env.CORS_ORIGINS.length === 0 && isDev) return callback(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked: ${origin}`));
      },
      // Refresh token httpOnly cookie me jaata hai — iske bina browser
      // cookie na bhejega na set karega.
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    pinoHttp({
      logger,
      // Health check har request log karke log bharne ka koi fayda nahi.
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
