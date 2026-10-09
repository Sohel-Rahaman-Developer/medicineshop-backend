import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { sendFile } from '../../core/export';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import { aiOffer } from './ai-settings';
import { balanceOf, coinInvoicePdf, orderCoins, testPayCoins, verifyCoins, wallet } from './coins';

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
    const t = tenantOf(req);
    fetched(res, { ...(await aiOffer()), balance: await balanceOf(t.shopId) });
  }),
);
aiRouter.get('/wallet', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await wallet(tenantOf(req))); }));
aiRouter.post('/coins/order', edit, validate({ body: orderSchema }), asyncHandler(async (req: Request, res: Response) => { created(res, await orderCoins(tenantOf(req), await actorOf(req), (req.body as { packCode: string }).packCode), 'Order created'); }));
aiRouter.post(
  '/coins/verify',
  edit,
  validate({ body: verifySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const r = await verifyCoins(tenantOf(req), await actorOf(req), req.body as { orderId: string; paymentId: string; signature: string });
    sent(res, r, r.confirming ? 'Payment received — confirming with the bank' : `${String(r.coins)} coins added`);
  }),
);
aiRouter.post('/coins/test-pay', edit, validate({ body: z.object({ orderId: z.string().trim().min(6).max(60) }).strict() }), asyncHandler(async (req: Request, res: Response) => { const r = await testPayCoins(tenantOf(req), await actorOf(req), (req.body as { orderId: string }).orderId); sent(res, r, `${String(r.coins)} coins added`); }));
aiRouter.get(
  '/coins/:id/invoice',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const f = await coinInvoicePdf(tenantOf(req), (req.params as { id: string }).id);
    sendFile(res, f.buf, `MedShop-invoice-${f.name}`, 'pdf');
  }),
);
