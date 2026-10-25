import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { sendFile } from '../../core/export';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { clientRequestId, idParams, objectId } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as svc from './transfers.service';

const sendBody = z
  .object({
    clientRequestId,
    toShopId: objectId,
    lines: z.array(z.object({ batchId: objectId, quantity: z.number('Quantity must be a number').int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(10_000_000) }).strict()).min(1, 'Add a medicine to send').max(100, 'At most 100 batches at once'),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
const cancelBody = z.object({ reason: z.string().trim().min(2, 'A reason is required').max(200) }).strict();

// v1.25.1: stock between the shops of one owner. Anyone who may change stock sends and receives; anyone who sees stock reads.
export const transfersRouter = Router();
transfersRouter.use(shopAuth);
const view = requirePermission('stock', 'view');
const edit = requirePermission('stock', 'edit');

transfersRouter.get('/', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.list(tenantOf(req))); }));
transfersRouter.post('/', edit, validate({ body: sendBody }), asyncHandler(async (req: Request, res: Response) => {
  const out = await svc.send(tenantOf(req), await actorOf(req), req.body as svc.SendInput, req.ip);
  created(res, out, `${out.number} sent — the stock is on its way`);
}));
transfersRouter.post('/:id/receive', edit, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  const out = await svc.receive(tenantOf(req), await actorOf(req), (req.params as { id: string }).id, req.ip);
  sent(res, out, `${out.number} received — the stock is added`);
}));
transfersRouter.post('/:id/cancel', edit, validate({ params: idParams, body: cancelBody }), asyncHandler(async (req: Request, res: Response) => {
  const out = await svc.cancel(tenantOf(req), await actorOf(req), (req.params as { id: string }).id, (req.body as { reason: string }).reason, req.ip);
  sent(res, out, `${out.number} cancelled — the stock is back`);
}));
transfersRouter.get('/:id/pdf', view, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  const f = await svc.pdf(tenantOf(req), (req.params as { id: string }).id);
  sendFile(res, f.buf, `Transfer-${f.name}`, 'pdf');
}));
