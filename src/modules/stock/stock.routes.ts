import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { sendFile } from '../../core/export';
import { attach, photoOf } from '../attachments/attachments.service';
import { movementsXlsx, reorderPdf } from '../exports/exports.service';
import { seesCost } from '../products/products.service';
import { photoSchema } from '../purchases/purchases.routes';
import { actorOf } from '../user/actor';
import * as svc from './stock.service';
import {
  adjustmentSchema,
  blockSchema,
  cursorQuerySchema,
  expiryQuerySchema,
  idsQuerySchema,
  movementsQuerySchema,
  openingSchema,
  reorderPdfQuerySchema,
  reorderQuerySchema,
  type AdjustmentInput,
  type ExpiryQuery,
  type MovementsQuery,
  type OpeningInput,
} from './stock.validation';

export const stockRouter = Router();
stockRouter.use(requireAuth, tenant);

const idOf = (req: Request) => (req.params as { id: string }).id;
const view = requirePermission('stock', 'view');

stockRouter.post(
  '/opening',
  requirePermission('stock', 'create'),
  validate({ body: openingSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await svc.addOpening(tenantOf(req), await actorOf(req), req.body as OpeningInput, req.ip);
    const msg = result.how === 'merged' ? `Added to batch ${result.batchNumber}` : `Batch ${result.batchNumber} added`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);

stockRouter.post(
  '/batches/:id/block',
  requirePermission('stock', 'edit'),
  validate({ params: idParams, body: blockSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.setBlocked(tenantOf(req), await actorOf(req), idOf(req), true, (req.body as { reason: string }).reason, req.ip);
    sent(res, null, 'Batch blocked — billing won’t sell it');
  }),
);

stockRouter.post(
  '/batches/:id/unblock',
  requirePermission('stock', 'edit'),
  validate({ params: idParams, body: blockSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.setBlocked(tenantOf(req), await actorOf(req), idOf(req), false, '', req.ip);
    sent(res, null, 'Batch unblocked');
  }),
);

stockRouter.get(
  '/batches',
  view,
  validate({ query: idsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.batchesByIds(tenantOf(req), (req.query as unknown as { ids: string[] }).ids));
  }),
);

stockRouter.get(
  '/batches/:id/why',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.why(tenantOf(req), idOf(req)));
  }),
);

stockRouter.get(
  '/movements',
  view,
  validate({ query: movementsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.movements(tenantOf(req), req.query as unknown as MovementsQuery);
    fetched(res, items, meta);
  }),
);

stockRouter.get(
  '/movements/export',
  requirePermission('stock', 'export'),
  validate({ query: movementsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sendFile(res, await movementsXlsx(tenantOf(req), req.query as unknown as MovementsQuery), 'Stock-movements', 'xlsx');
  }),
);

stockRouter.get(
  '/movements/people',
  view,
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.movementPeople(tenantOf(req)));
  }),
);

stockRouter.get(
  '/adjustments',
  view,
  validate({ query: cursorQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    const { items, meta } = await svc.listAdjustments(tenantOf(req), q.cursor, q.limit);
    fetched(res, items, meta);
  }),
);

stockRouter.get(
  '/adjustments/:id',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.getAdjustment(tenantOf(req), idOf(req)));
  }),
);

stockRouter.post(
  '/adjustments',
  requirePermission('stock', 'edit'),
  validate({ body: adjustmentSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const t = tenantOf(req);
    const { result, replayed } = await svc.adjust(t, await actorOf(req), req.body as AdjustmentInput, req.ip);
    const out = seesCost(t) ? result : { id: result.id, adjustmentNumber: result.adjustmentNumber, lines: result.lines };
    const msg = `${result.adjustmentNumber} saved`;
    if (replayed) sent(res, out, msg);
    else created(res, out, msg);
  }),
);

stockRouter.get(
  '/expiry',
  view,
  validate({ query: expiryQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { summary, items, meta } = await svc.expiry(tenantOf(req), req.query as unknown as ExpiryQuery);
    fetched(res, { summary, items }, meta);
  }),
);

stockRouter.get(
  '/reorder',
  view,
  validate({ query: reorderQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.reorder(tenantOf(req), (req.query as unknown as { target: number }).target));
  }),
);

stockRouter.get(
  '/adjustments/:id/photo',
  view,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await photoOf(tenantOf(req), 'StockAdjustment', idOf(req)));
  }),
);

stockRouter.post(
  '/adjustments/:id/photo',
  requirePermission('stock', 'edit'),
  validate({ params: idParams, body: photoSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await attach(tenantOf(req), await actorOf(req), 'StockAdjustment', idOf(req), (req.body as { photo: string }).photo, req.ip), 'Photo attached');
  }),
);

stockRouter.get(
  '/reorder/pdf',
  view,
  validate({ query: reorderPdfQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { target: number; supplierId?: string };
    const out = await reorderPdf(tenantOf(req), q.target, q.supplierId);
    sendFile(res, out.pdf, out.name, 'pdf');
  }),
);
