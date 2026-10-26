import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { sendFile } from '../../core/export';
import { needFeature, requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { objectId } from '../../core/zod';
import { actorOf } from '../user/actor';
import { giveBarcodes, items, LAYOUT_KEYS, MAX_LABELS, pdf, type PdfInput } from './labels.service';

// Barcode labels (Pro): optional — nothing here runs unless the person opens it; a product gets a code only when asked.
export const labelsRouter = Router();
labelsRouter.use(shopAuth, needFeature('labels'));

const itemsQuery = z
  .object({
    ids: z.string().optional().transform((v) => (v ? v.split(',').filter(Boolean) : undefined)).pipe(z.array(objectId).max(200).optional()),
    purchase: objectId.optional(),
  })
  .strict()
  .refine((q) => q.ids?.length || q.purchase, 'Pick products or a purchase');

const pdfBody = z
  .object({
    layout: z.enum(LAYOUT_KEYS),
    skip: z.number().int().min(0).max(64).default(0),
    show: z.object({ mrp: z.boolean(), batch: z.boolean(), shop: z.boolean() }).strict(),
    items: z.array(z.object({ productId: objectId, batchId: objectId.nullable().optional(), copies: z.number().int().min(1).max(500) }).strict()).min(1).max(300),
  })
  .strict()
  .refine((b) => b.items.reduce((s, i) => s + i.copies, 0) <= MAX_LABELS, `At most ${String(MAX_LABELS)} labels at a time`);

labelsRouter.get(
  '/items',
  requirePermission('products', 'view'),
  validate({ query: itemsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await items(tenantOf(req), req.query));
  }),
);

labelsRouter.post(
  '/barcodes',
  requirePermission('products', 'edit'),
  validate({ body: z.object({ productIds: z.array(objectId).min(1).max(200) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await giveBarcodes(tenantOf(req), await actorOf(req), (req.body as { productIds: string[] }).productIds, req.ip);
    sent(res, out, out.length === 1 ? 'Barcode given' : `${String(out.length)} barcodes given`);
  }),
);

labelsRouter.post(
  '/pdf',
  requirePermission('products', 'view'),
  validate({ body: pdfBody }),
  asyncHandler(async (req: Request, res: Response) => {
    sendFile(res, await pdf(tenantOf(req), req.body as PdfInput), 'Barcode-labels', 'pdf');
  }),
);
