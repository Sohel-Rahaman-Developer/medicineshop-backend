import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { sendFile } from '../../core/export';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { AppError } from '../../core/errors';
import { rangeSchema } from '../purchases/purchases.validation';
import { actorOf } from '../user/actor';
import { attach, photoOf } from '../attachments/attachments.service';
import { photoSchema } from '../purchases/purchases.routes';
import * as returns from './sale-returns.service';
import { billPdf, returnPdf } from './sale.pdf';
import * as offline from './offline.service';
import * as svc from './sales.service';
import {
  cancelSaleSchema,
  deviceSchema,
  offlineSaleSchema,
  type OfflineSaleInput,
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
posRouter.use(shopAuth);

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

// D104: offline billing — the counter's own series, its copy of what it sells, and its bills arriving later.
posRouter.post(
  '/offline/device',
  requirePermission('pos', 'create'),
  validate({ body: deviceSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await offline.registerDevice(tenantOf(req), await actorOf(req), req.body as { key: string; name: string }));
  }),
);

posRouter.get(
  '/offline/catalog',
  requirePermission('pos', 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await offline.catalog(tenantOf(req)));
  }),
);

posRouter.post(
  '/offline/sales',
  requirePermission('pos', 'create'),
  validate({ body: offlineSaleSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await offline.createOffline(tenantOf(req), await actorOf(req), req.body as OfflineSaleInput, req.ip);
    const msg = `${result.billNumber} saved`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);

export const salesRouter = Router();
salesRouter.use(shopAuth);
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

// D105: the prescription photographed with the bill. Seen by whoever may see the bill; added by whoever may bill.
salesRouter.get(
  '/:id/prescription',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.get(tenantOf(req), userOf(req), idOf(req));
    fetched(res, await photoOf(tenantOf(req), 'Sale', idOf(req)));
  }),
);

salesRouter.post(
  '/:id/prescription',
  requirePermission('sales', 'create'),
  validate({ params: idParams, body: photoSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.get(tenantOf(req), userOf(req), idOf(req));
    sent(res, await attach(tenantOf(req), await actorOf(req), 'Sale', idOf(req), (req.body as { photo: string }).photo, req.ip), 'Prescription photo saved with the bill');
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
saleReturnsRouter.use(shopAuth);

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
