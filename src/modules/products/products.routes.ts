import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import { importRows, importSchema, type ImportInput } from './products.import';
import * as svc from './products.service';
import { activeSchema, createProductSchema, listQuerySchema, updateProductSchema, type CreateProductInput, type ListQuery, type UpdateProductInput } from './products.validation';

export const productsRouter = Router();
productsRouter.use(requireAuth, tenant);

const idOf = (req: Request) => (req.params as { id: string }).id;
const view = requirePermission('products', 'view');

productsRouter.get(
  '/',
  view,
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.list(tenantOf(req), req.query as unknown as ListQuery);
    fetched(res, items, meta);
  }),
);

productsRouter.get(
  '/summary',
  view,
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.summary(tenantOf(req)));
  }),
);

productsRouter.get(
  '/companies',
  view,
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.companies(tenantOf(req)));
  }),
);

productsRouter.post(
  '/import',
  requirePermission('products', 'create'),
  requirePermission('stock', 'create'),
  validate({ body: importSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await importRows(tenantOf(req), await actorOf(req), req.body as ImportInput, req.ip);
    if (out.saved) sent(res, out, `${String(out.summary.rows)} rows imported`);
    else fetched(res, out);
  }),
);

productsRouter.get(
  '/:id',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.get(tenantOf(req), idOf(req)));
  }),
);

productsRouter.get(
  '/:id/batches',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.batchesOf(tenantOf(req), idOf(req)));
  }),
);

productsRouter.get(
  '/:id/received',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.received(tenantOf(req), idOf(req)));
  }),
);

productsRouter.get(
  '/:id/similar',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.similar(tenantOf(req), idOf(req)));
  }),
);

productsRouter.post(
  '/',
  requirePermission('products', 'create'),
  validate({ body: createProductSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as CreateProductInput;
    created(res, await svc.create(tenantOf(req), await actorOf(req), body, req.ip), `${body.name} saved`);
  }),
);

productsRouter.put(
  '/:id',
  requirePermission('products', 'edit'),
  validate({ params: idParams, body: updateProductSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as UpdateProductInput;
    await svc.update(tenantOf(req), await actorOf(req), idOf(req), body, req.ip);
    sent(res, null, `${body.name} saved`);
  }),
);

productsRouter.post(
  '/:id/active',
  requirePermission('products', 'edit'),
  validate({ params: idParams, body: activeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { isActive, version } = req.body as { isActive: boolean; version: number };
    const out = await svc.setActive(tenantOf(req), await actorOf(req), idOf(req), isActive, version, req.ip);
    sent(res, out, isActive ? 'Product reactivated' : 'Product deactivated — it no longer shows in billing');
  }),
);
