import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { sendFile } from '../../core/export';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { AppError } from '../../core/errors';
import { idParams, objectId } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as autopay from './autopay';
import * as svc from './subscription.service';

const orderSchema = z.object({ planCode: z.string().trim().min(1).max(20) }).strict();
const verifySchema = z.object({ orderId: z.string().trim().min(6).max(60), paymentId: z.string().trim().min(6).max(60), signature: z.string().trim().regex(/^[a-f0-9]{64}$/, 'Invalid signature') }).strict();
const testPaySchema = z.object({ orderId: z.string().trim().min(6).max(60) }).strict();
const subId = z.string().trim().min(6).max(60);
const autopayVerifySchema = z.object({ subscriptionId: subId, paymentId: z.string().trim().min(6).max(60), signature: z.string().trim().regex(/^[a-f0-9]{64}$/, 'Invalid signature') }).strict();
const cancelSchema = z.object({ reason: z.string().trim().min(3, 'Say why (3 letters at least)').max(200) }).strict();

// PLAN §8 / §33: plans are public; the rest is the shop's own plan. Owner pays and cancels (subscription: edit).
export const plansRouter = Router();
plansRouter.get('/', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.plans()); }));

export const subscriptionRouter = Router();
subscriptionRouter.use(shopAuth);
const view = requirePermission('subscription', 'view');
const edit = requirePermission('subscription', 'edit');

subscriptionRouter.get('/', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.current(tenantOf(req))); }));
subscriptionRouter.get('/payments', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.payments(tenantOf(req))); }));
subscriptionRouter.get(
  '/payments/:id/invoice',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const f = await svc.invoicePdf(tenantOf(req), (req.params as { id: string }).id);
    sendFile(res, f.buf, `MedShop-invoice-${f.name}`, 'pdf');
  }),
);
subscriptionRouter.post('/order', edit, validate({ body: orderSchema }), asyncHandler(async (req: Request, res: Response) => { created(res, await svc.order(tenantOf(req), await actorOf(req), (req.body as { planCode: string }).planCode), 'Order created'); }));
subscriptionRouter.post('/verify', edit, validate({ body: verifySchema }), asyncHandler(async (req: Request, res: Response) => { const r = await svc.verify(tenantOf(req), await actorOf(req), req.body as { orderId: string; paymentId: string; signature: string }); sent(res, r, r.confirming ? 'Payment received — confirming with the bank' : 'Payment received — thank you'); }));
subscriptionRouter.post('/test-pay', edit, validate({ body: testPaySchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.testPay(tenantOf(req), await actorOf(req), (req.body as { orderId: string }).orderId), 'Test payment received'); }));
subscriptionRouter.get(
  '/payments/:id/credit-notes/:refundId',
  view,
  validate({ params: z.object({ id: objectId, refundId: objectId }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const p = req.params as { id: string; refundId: string };
    const f = await autopay.creditNotePdf(tenantOf(req), p.id, p.refundId);
    sendFile(res, f.buf, `MedShop-credit-note-${f.name}`, 'pdf');
  }),
);
// B8c autopay: UPI Autopay / card mandate through Razorpay Subscriptions.
subscriptionRouter.post('/autopay', edit, validate({ body: orderSchema }), asyncHandler(async (req: Request, res: Response) => { created(res, await autopay.startAutopay(tenantOf(req), await actorOf(req), (req.body as { planCode: string }).planCode), 'Approve autopay to finish'); }));
subscriptionRouter.post('/autopay/verify', edit, validate({ body: autopayVerifySchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await autopay.verifyAutopay(tenantOf(req), await actorOf(req), req.body as { subscriptionId: string; paymentId: string; signature: string }), 'Autopay is on'); }));
subscriptionRouter.post('/autopay/test-approve', edit, validate({ body: z.object({ subscriptionId: subId }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await autopay.testApprove(tenantOf(req), await actorOf(req), (req.body as { subscriptionId: string }).subscriptionId), 'Autopay is on (test)'); }));
subscriptionRouter.post(
  '/autopay/stop',
  edit,
  validate({ body: cancelSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const t = tenantOf(req);
    if (!(await autopay.stopAutopay(t.shopId, await actorOf(req), (req.body as { reason: string }).reason, req.ip))) throw AppError.conflict('Autopay is not on');
    sent(res, await svc.current(t), 'Autopay stopped — the plan runs to its end date');
  }),
);
subscriptionRouter.post(
  '/cancel',
  edit,
  validate({ body: cancelSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.cancel(tenantOf(req), await actorOf(req), (req.body as { reason: string }).reason, req.ip);
    sent(res, await svc.current(tenantOf(req)), 'Plan cancelled — the shop is read-only now');
  }),
);

/** Razorpay calls this with no cookies; the signature over the raw body is the only proof (PLAN §8). */
export const razorpayWebhook = [
  express.raw({ type: 'application/json', limit: '100kb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    fetched(res, await svc.webhook(raw, req.get('x-razorpay-signature') ?? '', req.get('x-razorpay-event-id') ?? ''));
  }),
];
