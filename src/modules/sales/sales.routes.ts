import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { sendFile } from '../../core/export';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { AppError } from '../../core/errors';
import { rangeSchema } from '../purchases/purchases.validation';
import { actorOf } from '../user/actor';
import * as returns from './sale-returns.service';
import { billPdf, returnPdf } from './sale.pdf';
import * as svc from './sales.service';
import {
  cancelSaleSchema,
  posSearchSchema,
  returnListSchema,
  saleListSchema,
  saleReturnSchema,
  saleSchema,
  type ReturnListQuery,
  type SaleInput,
  type SaleListQuery,
  type SaleReturnInput,
} from './sales.validation';

const idOf = (req: Request) => (req.params as { id: string }).id;
const userOf = (req: Request) => {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth.userId;
};

export const posRouter = Router();
posRouter.use(requireAuth, tenant);

posRouter.get(
  '/search',
  requirePermission('pos', 'view'),
  validate({ query: posSearchSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { q: string; limit: number; ids?: string[] };
    fetched(res, await svc.posSearch(tenantOf(req), q.q, q.ids?.length ? 50 : q.limit, q.ids));
  }),
);

posRouter.get(
  '/settings',
  requirePermission('pos', 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.posSettings(tenantOf(req)));
  }),
);

export const salesRouter = Router();
salesRouter.use(requireAuth, tenant);
const view = requirePermission('sales', 'view');

salesRouter.post(
  '/',
  requirePermission('pos', 'create'),
  validate({ body: saleSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await svc.create(tenantOf(req), await actorOf(req), req.body as SaleInput, req.ip);
    const msg = `${result.billNumber} saved`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);

salesRouter.get(
  '/',
  view,
  validate({ query: saleListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.list(tenantOf(req), userOf(req), req.query as unknown as SaleListQuery);
    fetched(res, items, meta);
  }),
);

salesRouter.get(
  '/summary',
  view,
  validate({ query: rangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from: Date; to: Date };
    fetched(res, await svc.summary(tenantOf(req), userOf(req), q.from, q.to));
  }),
);

salesRouter.get(
  '/:id',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.get(tenantOf(req), userOf(req), idOf(req)));
  }),
);

salesRouter.get(
  '/:id/pdf',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const { pdf, name } = await billPdf(tenantOf(req), userOf(req), idOf(req));
    sendFile(res, pdf, name, 'pdf');
  }),
);

salesRouter.post(
  '/:id/cancel',
  requirePermission('sales', 'approve'),
  validate({ params: idParams, body: cancelSaleSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const r = await svc.cancel(tenantOf(req), await actorOf(req), idOf(req), (req.body as { reason: string }).reason, req.ip);
    sent(res, r, `${r.billNumber} cancelled — stock is back on the shelf`);
  }),
);

export const saleReturnsRouter = Router();
saleReturnsRouter.use(requireAuth, tenant);

// PLAN §15: sales:create starts a return (an accountant can't); the record scope applies to the bill.
saleReturnsRouter.post(
  '/',
  requirePermission('sales', 'create'),
  validate({ body: saleReturnSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await returns.create(tenantOf(req), await actorOf(req), req.body as SaleReturnInput, req.ip);
    const msg = `${result.returnNumber} saved — stock is back in its batch`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);

saleReturnsRouter.get(
  '/',
  view,
  validate({ query: returnListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await returns.list(tenantOf(req), userOf(req), req.query as unknown as ReturnListQuery);
    fetched(res, items, meta);
  }),
);

saleReturnsRouter.get(
  '/:id',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await returns.get(tenantOf(req), userOf(req), idOf(req)));
  }),
);

saleReturnsRouter.get(
  '/:id/pdf',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const { pdf, name } = await returnPdf(tenantOf(req), userOf(req), idOf(req));
    sendFile(res, pdf, name, 'pdf');
  }),
);
