import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { needFeature, requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { objectId } from '../../core/zod';
import { actorOf } from '../user/actor';
import { due, mark, type RefillAction } from './refills.service';

// D103: refills due — anyone who sees customers can look and remind; the list is worked out, never typed.
export const refillsRouter = Router();
refillsRouter.use(shopAuth, needFeature('refills'), requirePermission('customers', 'view'));

const pair = z.object({ customerId: objectId, productId: objectId }).strict();
const body = z.discriminatedUnion('action', [z.object({ action: z.literal('reminded'), how: z.enum(['whatsapp', 'call']) }).strict(), z.object({ action: z.literal('stop') }).strict(), z.object({ action: z.literal('resume') }).strict()]);

refillsRouter.get('/', asyncHandler(async (req: Request, res: Response) => { fetched(res, await due(tenantOf(req))); }));
refillsRouter.put('/:customerId/:productId', validate({ params: pair, body }), asyncHandler(async (req: Request, res: Response) => {
  const p = req.params as { customerId: string; productId: string };
  const a = req.body as RefillAction;
  await mark(tenantOf(req), await actorOf(req), p.customerId, p.productId, a);
  sent(res, null, a.action === 'reminded' ? 'Marked as reminded' : a.action === 'stop' ? 'Taken off the refill list' : 'Back on the refill list');
}));
