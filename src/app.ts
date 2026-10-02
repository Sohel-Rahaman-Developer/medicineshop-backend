import express from 'express';
import { NO_EXPIRY } from './modules/stock/stock.domain';
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
import { categoriesRouter } from './modules/categories/categories.routes';
import { invitationsRouter } from './modules/memberships/invitations.routes';
import { productsRouter } from './modules/products/products.routes';
import { racksRouter } from './modules/racks/racks.routes';
import { rolesRouter } from './modules/roles/roles.routes';
import { shopRouter, shopsRouter } from './modules/shops/shops.routes';
import { staffRouter } from './modules/staff/staff.routes';
import { stockRouter } from './modules/stock/stock.routes';
import { demandsRouter } from './modules/demands/demands.routes';
import { purchasesRouter, returnsRouter } from './modules/purchases/purchases.routes';
import { searchRouter } from './modules/search/search.routes';
import { suppliersRouter } from './modules/suppliers/suppliers.routes';

const PHOTO_PATH = /^\/(purchases|stock\/adjustments)\/[a-f0-9]{24}\/photo$/;

export function createApp() {
  const app = express();

  // Real client IP behind the proxy — rate limits and audit depend on it.
  app.set('trust proxy', 1);
  const noExpiry = NO_EXPIRY.toISOString();
  app.set('json replacer', (_key: string, value: unknown) => (value === noExpiry ? null : value));

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
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Shop-Id'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  );

  // Document photos (supplier invoice, damaged stock) are the only bodies allowed past 100 KB.
  const photoJson = express.json({ limit: '850kb' });
  app.use(env.API_PREFIX, (req, res, next) => {
    if (PHOTO_PATH.test(req.path)) photoJson(req, res, next);
    else next();
  });
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
  app.use(`${env.API_PREFIX}/shops`, shopsRouter);
  app.use(`${env.API_PREFIX}/shop`, shopRouter);
  app.use(`${env.API_PREFIX}/invitations`, invitationsRouter);
  app.use(`${env.API_PREFIX}/staff`, staffRouter);
  app.use(`${env.API_PREFIX}/roles`, rolesRouter);
  app.use(`${env.API_PREFIX}/categories`, categoriesRouter);
  app.use(`${env.API_PREFIX}/racks`, racksRouter);
  app.use(`${env.API_PREFIX}/products`, productsRouter);
  app.use(`${env.API_PREFIX}/stock`, stockRouter);
  app.use(`${env.API_PREFIX}/suppliers`, suppliersRouter);
  app.use(`${env.API_PREFIX}/purchases`, purchasesRouter);
  app.use(`${env.API_PREFIX}/purchase-returns`, returnsRouter);
  app.use(`${env.API_PREFIX}/demands`, demandsRouter);
  app.use(`${env.API_PREFIX}/search`, searchRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
