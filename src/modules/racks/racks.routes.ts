import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { rackCode } from '../products/products.validation';
import { rackBatches } from '../stock/stock.service';
import { rackBatchesQuerySchema } from '../stock/stock.validation';
import { actorOf } from '../user/actor';
import { STORAGE_TYPES } from './rack.model';
import * as svc from './racks.service';

export const racksRouter = Router();
racksRouter.use(requireAuth, tenant);

const rackSchema = z
  .object({
    code: rackCode.refine((v) => v !== '', 'Rack code is required'),
    name: z.string().trim().max(40).default(''),
    storageType: z.enum(STORAGE_TYPES),
  })
  .strict();
type RackInput = z.infer<typeof rackSchema>;

racksRouter.get(
  '/',
  requirePermission('stock', 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.list(tenantOf(req)));
  }),
);

racksRouter.get(
  '/find',
  requirePermission('stock', 'view'),
  validate({ query: z.object({ q: z.string().trim().min(2, 'Type at least 2 letters').max(60) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.find(tenantOf(req), (req.query as { q: string }).q));
  }),
);

racksRouter.get(
  '/batches',
  requirePermission('stock', 'view'),
  validate({ query: rackBatchesQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await rackBatches(tenantOf(req), (req.query as { rack: string }).rack));
  }),
);

racksRouter.post(
  '/',
  requirePermission('stock', 'edit'),
  validate({ body: rackSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await svc.create(tenantOf(req), await actorOf(req), req.body as RackInput, req.ip);
    created(res, out, `Rack ${out.code} added`);
  }),
);

racksRouter.put(
  '/:id',
  requirePermission('stock', 'edit'),
  validate({ params: idParams, body: rackSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await svc.update(tenantOf(req), await actorOf(req), (req.params as { id: string }).id, req.body as RackInput, req.ip);
    sent(res, out, `Rack ${out.code} saved`);
  }),
);
