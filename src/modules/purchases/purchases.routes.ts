import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { sendFile } from '../../core/export';
import { attach, photoOf } from '../attachments/attachments.service';
import { purchasePdf } from '../exports/exports.service';
import { actorOf } from '../user/actor';
import { billPreviewSchema, previewBill, type BillPreviewInput } from './bill-import';
import * as svc from './purchases.service';
import {
  cancelSchema,
  candidatesSchema,
  lineInfoSchema,
  purchaseListSchema,
  purchaseSchema,
  rangeSchema,
  returnListSchema,
  returnSchema,
  settleSchema,
  type PurchaseInput,
  type PurchaseListQuery,
  type ReturnInput,
  type ReturnListQuery,
} from './purchases.validation';
import * as rsvc from './returns.service';

export const photoSchema = z.object({ photo: z.string().max(820_000, 'That photo is too large') }).strict();

const idOf = (req: Request) => (req.params as { id: string }).id;

export const purchasesRouter = Router();
purchasesRouter.use(requireAuth, tenant);
const view = requirePermission('purchases', 'view');
const create = requirePermission('purchases', 'create');

purchasesRouter.get(
  '/',
  view,
  validate({ query: purchaseListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.list(tenantOf(req), req.query as unknown as PurchaseListQuery);
    fetched(res, items, meta);
  }),
);

purchasesRouter.get(
  '/summary',
  view,
  validate({ query: rangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from: Date; to: Date };
    fetched(res, await svc.summary(tenantOf(req), q.from, q.to));
  }),
);

purchasesRouter.get(
  '/line-info',
  create,
  validate({ query: lineInfoSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.lineInfo(tenantOf(req), (req.query as unknown as { productId: string }).productId));
  }),
);

// D77: what a supplier bill would do, line by line — nothing is saved.
purchasesRouter.post(
  '/import/preview',
  create,
  validate({ body: billPreviewSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await previewBill(tenantOf(req), req.body as BillPreviewInput));
  }),
);

purchasesRouter.post(
  '/',
  create,
  validate({ body: purchaseSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await svc.create(tenantOf(req), await actorOf(req), req.body as PurchaseInput, req.ip);
    const msg = `${result.purchaseNumber} saved`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);

purchasesRouter.get(
  '/:id',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.get(tenantOf(req), idOf(req)));
  }),
);

purchasesRouter.get(
  '/:id/pdf',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await purchasePdf(tenantOf(req), idOf(req));
    sendFile(res, out.pdf, out.name, 'pdf');
  }),
);

purchasesRouter.post(
  '/:id/cancel',
  requirePermission('purchases', 'approve'),
  validate({ params: idParams, body: cancelSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await svc.cancel(tenantOf(req), await actorOf(req), idOf(req), (req.body as { reason: string }).reason, req.ip);
    sent(res, out, `${out.purchaseNumber} cancelled`);
  }),
);

purchasesRouter.get(
  '/:id/photo',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await photoOf(tenantOf(req), 'Purchase', idOf(req)));
  }),
);

purchasesRouter.post(
  '/:id/photo',
  create,
  validate({ params: idParams, body: photoSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await attach(tenantOf(req), await actorOf(req), 'Purchase', idOf(req), (req.body as { photo: string }).photo, req.ip), 'Invoice photo attached');
  }),
);

export const returnsRouter = Router();
returnsRouter.use(requireAuth, tenant);

returnsRouter.get(
  '/',
  view,
  validate({ query: returnListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await rsvc.list(tenantOf(req), req.query as unknown as ReturnListQuery);
    fetched(res, items, meta);
  }),
);

returnsRouter.get(
  '/candidates',
  create,
  validate({ query: candidatesSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { supplierId: string; purchaseId?: string };
    fetched(res, await rsvc.candidates(tenantOf(req), q.supplierId, q.purchaseId));
  }),
);

returnsRouter.post(
  '/',
  create,
  validate({ body: returnSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await rsvc.create(tenantOf(req), await actorOf(req), req.body as ReturnInput, req.ip);
    const msg = `${result.returnNumber} saved`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);

returnsRouter.get(
  '/:id',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await rsvc.get(tenantOf(req), idOf(req)));
  }),
);

returnsRouter.post(
  '/:id/settle',
  requirePermission('purchases', 'edit'),
  validate({ params: idParams, body: settleSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await rsvc.settle(tenantOf(req), await actorOf(req), idOf(req), (req.body as { creditNoteNumber: string }).creditNoteNumber, req.ip);
    sent(res, out, `${out.returnNumber} settled`);
  }),
);
