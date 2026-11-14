import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { asyncHandler } from '../../core/async-handler';
import { perUser } from '../../core/middleware/rate-limit';
import { sendFile } from '../../core/export';
import { needFeature, notInDemo, requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import { aiOffer } from './ai-settings';
import { coinInvoicePdf, orderCoins, testPayCoins, verifyCoins, wallet } from './coins';
import { listen, listenOffer, listenSchema, type ListenInput } from './listen';
import { meterOf, shopAi } from './meter';

const orderSchema = z.object({ packCode: z.string().trim().min(1).max(20) }).strict();
const verifySchema = z.object({ orderId: z.string().trim().min(6).max(60), paymentId: z.string().trim().min(6).max(60), signature: z.string().trim().regex(/^[a-f0-9]{64}$/, 'Invalid signature') }).strict();

// D78: AI coins. The bill screen asks /offer (purchases); the coins page and buying are the plan's (subscription).
export const aiRouter = Router();
aiRouter.use(shopAuth);
const view = requirePermission('subscription', 'view');
const edit = requirePermission('subscription', 'edit');

aiRouter.get(
  '/offer',
  requirePermission('purchases', 'create'),
  asyncHandler(async (req: Request, res: Response) => {
    const mine = await shopAi(tenantOf(req).shopId);
    fetched(res, { ...(await aiOffer()), coinsPerPage: mine.page.need, mostPerPage: mine.page.most, usualPerPage: mine.page.usual, free: mine.free, balance: mine.balance });
  }),
);
// A voice message for Ask AI or the stock chat: anyone in the shop whose plan has either.
const voice = (req: Request, res: Response, next: NextFunction) => {
  if (tenantOf(req).features.includes('ai')) next();
  else needFeature('ask')(req, res, next);
};
aiRouter.get('/listen', voice, asyncHandler(async (req: Request, res: Response) => { fetched(res, await listenOffer(tenantOf(req))); }));
aiRouter.post(
  '/listen',
  voice,
  perUser({ limit: env.RATE_ASK_PER_USER_PER_MIN, name: 'rl-listen' }),
  validate({ body: listenSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await listen(tenantOf(req), await actorOf(req), req.body as ListenInput));
  }),
);
// The header's tokens and free AI: anyone in the shop sees them, like the Yes before a job.
aiRouter.get('/meter', asyncHandler(async (req: Request, res: Response) => { fetched(res, await meterOf(tenantOf(req).shopId)); }));
aiRouter.get('/wallet', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await wallet(tenantOf(req))); }));
aiRouter.post('/coins/order', edit, notInDemo, validate({ body: orderSchema }), asyncHandler(async (req: Request, res: Response) => { created(res, await orderCoins(tenantOf(req), await actorOf(req), (req.body as { packCode: string }).packCode), 'Order created'); }));
aiRouter.post(
  '/coins/verify',
  edit,
  notInDemo,
  validate({ body: verifySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const r = await verifyCoins(tenantOf(req), await actorOf(req), req.body as { orderId: string; paymentId: string; signature: string });
    sent(res, r, r.confirming ? 'Payment received — confirming with the bank' : `${String(r.coins)} tokens added`);
  }),
);
aiRouter.post('/coins/test-pay', edit, notInDemo, validate({ body: z.object({ orderId: z.string().trim().min(6).max(60) }).strict() }), asyncHandler(async (req: Request, res: Response) => { const r = await testPayCoins(tenantOf(req), await actorOf(req), (req.body as { orderId: string }).orderId); sent(res, r, `${String(r.coins)} tokens added`); }));
aiRouter.get(
  '/coins/:id/invoice',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const f = await coinInvoicePdf(tenantOf(req), (req.params as { id: string }).id);
    sendFile(res, f.buf, `MedBox24-invoice-${f.name}`, 'pdf');
  }),
);
