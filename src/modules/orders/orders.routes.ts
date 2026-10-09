import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as svc from './orders.service';
import { cancelOrderSchema, linkItemSchema, orderListSchema, orderSchema, type CancelOrderInput, type OrderInput, type OrderListQuery } from './orders.validation';

const idOf = (req: Request) => (req.params as { id: string }).id;

// PLAN §35.1: customer orders belong to the counter (pos:create); keeping an advance needs sales:approve (service).
export const ordersRouter = Router();
ordersRouter.use(shopAuth);
const counter = requirePermission('pos', 'create');

ordersRouter.post(
  '/',
  counter,
  validate({ body: orderSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await svc.create(tenantOf(req), await actorOf(req), req.body as OrderInput, req.ip);
    const msg = `${result.orderNumber} saved`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);

ordersRouter.get(
  '/',
  counter,
  validate({ query: orderListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.list(tenantOf(req), req.query as unknown as OrderListQuery);
    fetched(res, items, meta);
  }),
);

ordersRouter.get(
  '/summary',
  counter,
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.summary(tenantOf(req)));
  }),
);

ordersRouter.get(
  '/:id',
  counter,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.get(tenantOf(req), idOf(req)));
  }),
);

ordersRouter.post(
  '/:id/link',
  counter,
  validate({ params: idParams, body: linkItemSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const b = req.body as { index: number; productId: string };
    const r = await svc.link(tenantOf(req), await actorOf(req), idOf(req), b.index, b.productId, req.ip);
    sent(res, r, `Linked on ${r.orderNumber}`);
  }),
);

ordersRouter.post(
  '/:id/cancel',
  counter,
  validate({ params: idParams, body: cancelOrderSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const r = await svc.cancel(tenantOf(req), await actorOf(req), idOf(req), req.body as CancelOrderInput, req.ip);
    sent(res, r, `${r.orderNumber} cancelled`);
  }),
);
