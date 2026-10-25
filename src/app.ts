import express from 'express';
import { NO_EXPIRY } from './modules/stock/stock.domain';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { allowedOrigins, env, isProd } from './config/env';
import { logger } from './config/logger';
import { csrfProtection } from './core/middleware/csrf';
import { jsonGuard } from './core/middleware/json-guard';
import { apiLimiter, fileLimiter } from './core/middleware/rate-limit';
import { errorHandler, notFoundHandler } from './core/middleware/error-handler';
import { healthRouter } from './modules/health/health.routes';
import { releaseRouter } from './modules/release/release.routes';
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
import { customersRouter, doctorsRouter } from './modules/customers/customers.routes';
import { fieldRouter } from './modules/field/field.routes';
import { dayCloseRouter } from './modules/dayclose/dayclose.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { loyaltyRouter } from './modules/loyalty/loyalty.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { ordersRouter } from './modules/orders/orders.routes';
import { clinicRouter } from './modules/clinic/clinic.routes';
import { posRouter, saleReturnsRouter, salesRouter } from './modules/sales/sales.routes';
import { searchRouter } from './modules/search/search.routes';
import { taxRouter } from './modules/tax/tax.routes';
import { expensesRouter } from './modules/expenses/expenses.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { plansRouter, razorpayWebhook, subscriptionRouter } from './modules/subscription/subscription.routes';
import { aiRouter } from './modules/ai/ai.routes';
import { askRouter } from './modules/ask/ask.routes';
import { adminRouter, platformRouter, supportAccessRouter } from './modules/admin/admin.routes';
import { brandRouter } from './modules/branding/branding.routes';
import { publicRouter } from './modules/public/public.routes';
import { webAddressRouter } from './modules/webaddress/web-address.routes';
import { branchesRouter } from './modules/branches/branches.routes';
import { transfersRouter } from './modules/transfers/transfers.routes';
import { shopOfDomainOrigin } from './modules/owndomain/own-domain.service';
import { shopOfOrigin } from './modules/webaddress/web-address.service';
import { isOurOrigin, trustMoreOrigins } from './core/origins';
import { suppliersRouter } from './modules/suppliers/suppliers.routes';
import { referralRouter } from './modules/referral/referral.routes';
import { timing } from './modules/perf/perf';
import { perfRouter } from './modules/perf/perf.routes';

const PHOTO_PATH = /^\/(purchases|stock\/adjustments)\/[a-f0-9]{24}\/photo$/;
// A supplier bill file comes base64 — the same 850 KB ceiling as a photo.
const BILL_PATH = /^\/purchases\/import\/read$/;
// D78: a scan or a phone photo for AI reading — up to about 4 MB (Nginx has its own block for this path).
const AI_BILL_PATH = /^\/purchases\/import\/ai$/;
// A logo upload — the platform's from the admin console or a shop's own (≤ 600 KB image).
const BRAND_PATH = /^\/(admin\/brand|shop\/logo)$/;
// Routes that build a PDF or an Excel file.
const FILE_PATH = /\/(export|pdf|invoice|template|credit-notes\/[^/]+)$/;

export function createApp() {
  const app = express();

  // Real client IP behind the proxy — rate limits and audit depend on it.
  app.set('trust proxy', 1);
  // Query values stay plain strings: `?q[$ne]=x` can never turn into a database operator.
  app.set('query parser', 'simple');
  // Answers are never cached (no-store), so an ETag only tells the world which framework made it.
  app.set('etag', false);
  app.use(timing);
  // Local load tests see which worker answered; production never says.
  if (!isProd) app.use((_req, res, next) => { res.setHeader('X-Worker', String(process.pid)); next(); });
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
  // A shop's live web address (D94) counts as the shop app.
  // v1.26: so does a shop's live own domain (its /api is this API, behind the same nginx).
  const shopOfAny = async (origin: string) => (await shopOfOrigin(origin)) ?? shopOfDomainOrigin(origin);
  trustMoreOrigins(async (origin) => (await shopOfAny(origin)) !== null, shopOfAny);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (origin !== undefined && allowedOrigins.includes(origin)) return callback(null, true);
        isOurOrigin(origin).then((ok) => { callback(null, ok); }, () => { callback(null, false); });
      },
      // Auth rides in httpOnly cookies; without this the browser neither sends nor stores them.
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Shop-Id', 'X-Lang'],
      // PDF / Excel names come in Content-Disposition; unexposed, every download was "medbox24-file".
      exposedHeaders: ['Content-Disposition'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  );

  // Before the JSON parser and CSRF: Razorpay sends no cookies and signs the raw body.
  app.post(`${env.API_PREFIX}/webhooks/razorpay`, ...razorpayWebhook);

  // Document photos (supplier invoice, damaged stock) are the only bodies allowed past 100 KB.
  const photoJson = express.json({ limit: '850kb' });
  const aiJson = express.json({ limit: '6mb' });
  app.use(env.API_PREFIX, (req, res, next) => {
    if (PHOTO_PATH.test(req.path) || BILL_PATH.test(req.path) || BRAND_PATH.test(req.path)) photoJson(req, res, next);
    else if (AI_BILL_PATH.test(req.path)) aiJson(req, res, next);
    else next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(jsonGuard);
  app.use(cookieParser());

  // Every API response is private to the signed-in user — no shared or browser caching.
  app.use(env.API_PREFIX, (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()' });
    next();
  });
  // A minute at a time per person (or IP), files a smaller allowance on top; health stays open for uptime monitors.
  app.use(env.API_PREFIX, (req, res, next) => {
    if (req.path === '/health') return next();
    apiLimiter(req, res, (err?: unknown) => {
      if (err !== undefined || !FILE_PATH.test(req.path)) return next(err);
      fileLimiter(req, res, next);
    });
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
  app.use(`${env.API_PREFIX}/release`, releaseRouter);
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
  app.use(`${env.API_PREFIX}/pos`, posRouter);
  app.use(`${env.API_PREFIX}/sales`, salesRouter);
  app.use(`${env.API_PREFIX}/sale-returns`, saleReturnsRouter);
  app.use(`${env.API_PREFIX}/orders`, ordersRouter);
  app.use(`${env.API_PREFIX}/day-close`, dayCloseRouter);
  app.use(`${env.API_PREFIX}/customers`, customersRouter);
  app.use(`${env.API_PREFIX}/loyalty`, loyaltyRouter);
  app.use(`${env.API_PREFIX}/notifications`, notificationsRouter);
  app.use(`${env.API_PREFIX}/audit`, auditRouter);
  app.use(`${env.API_PREFIX}/tax`, taxRouter);
  app.use(`${env.API_PREFIX}/expenses`, expensesRouter);
  app.use(`${env.API_PREFIX}/reports`, reportsRouter);
  app.use(`${env.API_PREFIX}/dashboard`, dashboardRouter);
  app.use(`${env.API_PREFIX}/plans`, plansRouter);
  app.use(`${env.API_PREFIX}/subscription`, subscriptionRouter);
  app.use(`${env.API_PREFIX}/referral`, referralRouter);
  app.use(`${env.API_PREFIX}/ai`, aiRouter);
  app.use(`${env.API_PREFIX}/ask`, askRouter);
  app.use(`${env.API_PREFIX}/admin`, adminRouter);
  app.use(`${env.API_PREFIX}/field`, fieldRouter);
  app.use(`${env.API_PREFIX}/platform`, platformRouter);
  app.use(`${env.API_PREFIX}/brand`, brandRouter);
  app.use(`${env.API_PREFIX}/public`, publicRouter);
  app.use(`${env.API_PREFIX}/web-address`, webAddressRouter);
  app.use(`${env.API_PREFIX}/branches`, branchesRouter);
  app.use(`${env.API_PREFIX}/transfers`, transfersRouter);
  app.use(`${env.API_PREFIX}/perf`, perfRouter);
  app.use(`${env.API_PREFIX}/support-access`, supportAccessRouter);
  app.use(`${env.API_PREFIX}/doctors`, doctorsRouter);
  app.use(`${env.API_PREFIX}/clinic`, clinicRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
