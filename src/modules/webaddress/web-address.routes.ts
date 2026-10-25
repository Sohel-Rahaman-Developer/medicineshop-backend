import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { sendFile } from '../../core/export';
import { langOf, sayFields } from '../../core/lang';
import { notInDemo, requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import { ADDRESS_PERIODS, type AddressPeriod } from './web-address.model';
import * as pay from './web-address-pay';
import * as svc from './web-address.service';

const nameBody = z.object({ name: z.string('Type a name').trim().min(1, 'Type a name').max(40, 'At most 30 letters') }).strict();

// D94: Settings → Web address. The owner (settings edit) asks; anyone who sees settings sees the answer.
export const webAddressRouter = Router();
webAddressRouter.use(shopAuth);

webAddressRouter.get('/', requirePermission('settings', 'view'), asyncHandler(async (req: Request, res: Response) => { const t = tenantOf(req); fetched(res, { ...(await svc.mine(t)), ...(await pay.payInfo(t)) }); }));
webAddressRouter.get('/check', requirePermission('settings', 'edit'), validate({ query: nameBody }), asyncHandler(async (req: Request, res: Response) => {
  fetched(res, sayFields(langOf(req), await svc.check(tenantOf(req), (req.query as { name: string }).name), ['why']));
}));
webAddressRouter.post('/', requirePermission('settings', 'edit'), validate({ body: nameBody }), asyncHandler(async (req: Request, res: Response) => {
  const out = await svc.request(tenantOf(req), await actorOf(req), (req.body as { name: string }).name, req.ip);
  sent(res, out, `Asked for ${out?.url ?? ''} — MedBox24 will call you`);
}));
webAddressRouter.delete('/', requirePermission('settings', 'edit'), asyncHandler(async (req: Request, res: Response) => {
  await svc.withdraw(tenantOf(req), await actorOf(req), req.ip);
  sent(res, { ok: true }, 'Request taken back');
}));

// v1.24.1: the owner pays the add-on like a plan (subscription: edit); invoices for whoever sees the plan.
const payBody = z.object({ period: z.enum(ADDRESS_PERIODS) }).strict();
const verifyBody = z.object({ orderId: z.string().trim().min(6).max(60), paymentId: z.string().trim().min(6).max(60), signature: z.string().trim().regex(/^[a-f0-9]{64}$/, 'Invalid signature') }).strict();
const payEdit = [notInDemo, requirePermission('subscription', 'edit')];
webAddressRouter.post('/order', ...payEdit, validate({ body: payBody }), asyncHandler(async (req: Request, res: Response) => { created(res, await pay.orderAddress(tenantOf(req), await actorOf(req), (req.body as { period: AddressPeriod }).period), 'Order created'); }));
webAddressRouter.post('/verify', ...payEdit, validate({ body: verifyBody }), asyncHandler(async (req: Request, res: Response) => {
  const r = await pay.verifyAddress(tenantOf(req), await actorOf(req), req.body as { orderId: string; paymentId: string; signature: string });
  sent(res, r, r.confirming ? 'Payment received — confirming with the bank' : 'Payment received — thank you');
}));
webAddressRouter.post('/test-pay', ...payEdit, validate({ body: z.object({ orderId: z.string().trim().min(6).max(60) }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await pay.testPayAddress(tenantOf(req), await actorOf(req), (req.body as { orderId: string }).orderId), 'Test payment received'); }));
webAddressRouter.get('/payments/:id/invoice', requirePermission('subscription', 'view'), validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  const f = await pay.addressInvoicePdf(tenantOf(req), (req.params as { id: string }).id);
  sendFile(res, f.buf, `MedBox24-invoice-${f.name}`, 'pdf');
}));
