import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { objectId } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as svc from './demands.service';

export const demandsRouter = Router();
demandsRouter.use(requireAuth, tenant);

const view = requirePermission('products', 'view');
const idsSchema = z.object({ ids: z.array(objectId).min(1).max(100) }).strict();

demandsRouter.get('/', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.list(tenantOf(req))); }));

demandsRouter.post(
  '/',
  view,
  validate({ body: svc.demandSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const d = await svc.add(tenantOf(req), await actorOf(req), req.body as svc.DemandInput);
    created(res, d, 'Added to the buy list');
  }),
);

demandsRouter.post(
  '/link',
  requirePermission('products', 'create'),
  validate({ body: svc.linkSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as { ids: string[]; productId: string };
    sent(res, await svc.link(tenantOf(req), await actorOf(req), b.ids, b.productId, req.ip), 'Linked to the product');
  }),
);

demandsRouter.post(
  '/clear',
  view,
  validate({ body: idsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.clear(tenantOf(req), await actorOf(req), (req.body as { ids: string[] }).ids), 'Cleared from the buy list');
  }),
);
