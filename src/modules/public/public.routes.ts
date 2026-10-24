import { Router, type Request, type Response } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { perWorker } from '../../core/middleware/rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { AppError } from '../../core/errors';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { TOKEN, publicPoints, publicShop } from '../loyalty/points-link';
import { ShopModel } from '../shops/shop.model';
import { logoBytes } from '../shops/shop-logo';
import * as categories from '../categories/categories.service';

/** D92: pages a customer opens without signing in — a shop's loyalty QR page and their own points link. */
export const publicRouter = Router();

// Guessing a token by brute force is hopeless (144 bits); this keeps a scraper from hammering the database.
publicRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: perWorker(60),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `public:${ipKeyGenerator(req.ip ?? '')}`,
    handler: (_req, _res, next) => { next(AppError.rateLimited()); },
  }),
);

const code = z.object({ code: z.string().regex(/^[a-z2-9]{8}$/) }).strict();
const linkToken = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict();

/** The category link from a super admin's email: see the ask, then one tap to approve or reject. */
publicRouter.get('/category-requests/:token', validate({ params: linkToken }), asyncHandler(async (req: Request, res: Response) => {
  fetched(res, await categories.byLink((req.params as { token: string }).token));
}));
publicRouter.post('/category-requests/:token', validate({ params: linkToken, body: z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(200).default('') }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  const b = req.body as { decision: 'approve' | 'reject'; reason: string };
  const out = await categories.decideByLink((req.params as { token: string }).token, b.decision, b.reason, req.ip);
  sent(res, out, b.decision === 'approve' ? `“${out.name}” added for every shop` : `“${out.name}” turned down`);
}));

publicRouter.get('/points/:token', validate({ params: z.object({ token: z.string().regex(TOKEN) }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  res.set('X-Robots-Tag', 'noindex');
  fetched(res, await publicPoints((req.params as { token: string }).token));
}));

publicRouter.get('/shops/:code', validate({ params: code }), asyncHandler(async (req: Request, res: Response) => {
  fetched(res, await publicShop((req.params as { code: string }).code));
}));

publicRouter.get('/shops/:code/logo.png', validate({ params: code }), asyncHandler(async (req: Request, res: Response) => {
  const s = await ShopModel.findOne({ publicCode: (req.params as { code: string }).code }).select('_id').lean();
  const png = s ? await logoBytes(s._id) : null;
  if (!png) throw AppError.notFound('No logo');
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  res.send(png); // nosemgrep
}));
