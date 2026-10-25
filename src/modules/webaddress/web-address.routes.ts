import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { langOf, sayFields } from '../../core/lang';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { actorOf } from '../user/actor';
import * as svc from './web-address.service';

const nameBody = z.object({ name: z.string('Type a name').trim().min(1, 'Type a name').max(40, 'At most 30 letters') }).strict();

// D94: Settings → Web address. The owner (settings edit) asks; anyone who sees settings sees the answer.
export const webAddressRouter = Router();
webAddressRouter.use(shopAuth);

webAddressRouter.get('/', requirePermission('settings', 'view'), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.mine(tenantOf(req))); }));
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
