import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { sendFile } from '../../core/export';
import { ledgerPdf } from '../exports/exports.service';
import { actorOf } from '../user/actor';
import * as svc from './suppliers.service';
import { ledgerQuerySchema, paymentSchema, supplierListSchema, supplierSchema, type PaymentInput, type SupplierInput, type SupplierListQuery } from './suppliers.validation';

export const suppliersRouter = Router();
suppliersRouter.use(shopAuth);

const idOf = (req: Request) => (req.params as { id: string }).id;
const view = requirePermission('suppliers', 'view');

suppliersRouter.get(
  '/',
  view,
  validate({ query: supplierListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.list(tenantOf(req), req.query as unknown as SupplierListQuery);
    fetched(res, items, meta);
  }),
);

suppliersRouter.get(
  '/summary',
  view,
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.summary(tenantOf(req)));
  }),
);

suppliersRouter.get(
  '/chart',
  view,
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.chart(tenantOf(req)));
  }),
);

suppliersRouter.post(
  '/',
  requirePermission('suppliers', 'create'),
  validate({ body: supplierSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const s = await svc.create(tenantOf(req), await actorOf(req), req.body as SupplierInput, req.ip);
    created(res, s, `${s.name} added`);
  }),
);

suppliersRouter.get(
  '/:id',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.get(tenantOf(req), idOf(req)));
  }),
);

suppliersRouter.put(
  '/:id',
  requirePermission('suppliers', 'edit'),
  validate({ params: idParams, body: supplierSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const s = await svc.update(tenantOf(req), await actorOf(req), idOf(req), req.body as SupplierInput, req.ip);
    sent(res, s, `${s.name} saved`);
  }),
);

suppliersRouter.get(
  '/:id/ledger',
  view,
  validate({ params: idParams, query: ledgerQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from?: Date; to?: Date };
    fetched(res, await svc.ledger(tenantOf(req), idOf(req), q.from, q.to));
  }),
);

suppliersRouter.get(
  '/:id/ledger/pdf',
  view,
  validate({ params: idParams, query: ledgerQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from?: Date; to?: Date };
    const out = await ledgerPdf(tenantOf(req), idOf(req), q.from, q.to);
    sendFile(res, out.pdf, out.name, 'pdf');
  }),
);

suppliersRouter.get(
  '/:id/open-invoices',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.openInvoices(tenantOf(req), idOf(req)));
  }),
);

suppliersRouter.get(
  '/:id/products',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.productsOf(tenantOf(req), idOf(req)));
  }),
);

// Sandbox gives supplier payments to suppliers: edit; PLAN §7 says accountants pay suppliers — open (BUILD §11 B3).
suppliersRouter.post(
  '/:id/payments',
  requirePermission('suppliers', 'edit'),
  validate({ params: idParams, body: paymentSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await svc.pay(tenantOf(req), await actorOf(req), idOf(req), req.body as PaymentInput, req.ip);
    const msg = `${result.paymentNumber} saved`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);
