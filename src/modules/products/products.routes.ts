import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { AppError } from '../../core/errors';
import { can } from '../rbac/permissions';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { langOf, sayNotes } from '../../core/lang';
import { z } from 'zod';
import { clientRequestId, idParams } from '../../core/zod';
import { sendFile } from '../../core/export';
import { productsXlsx } from '../exports/exports.service';
import { actorOf } from '../user/actor';
import { importProgress, importRows, importSchema, importTemplate, type ImportInput } from './products.import';
import { addWithStock } from './products.add';
import { gridQuerySchema, gridRows, gridSaveSchema, saveGrid, type GridQuery, type GridSave } from './products.grid';
import * as svc from './products.service';
import { activeSchema, createProductSchema, listQuerySchema, pricesSchema, updateProductSchema, type CreateProductInput, type ListQuery, type PricesInput, type UpdateProductInput } from './products.validation';

export const productsRouter = Router();
productsRouter.use(shopAuth);

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
  '/export',
  requirePermission('products', 'export'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sendFile(res, await productsXlsx(tenantOf(req), req.query as unknown as ListQuery), 'Products', 'xlsx');
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
  '/defaults',
  requirePermission('products', 'create'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.categoryDefaults(tenantOf(req)));
  }),
);

// The edit grid: products with their batches, and their changes saved in one go.
productsRouter.get(
  '/grid',
  requirePermission('products', 'edit'),
  validate({ query: gridQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await gridRows(tenantOf(req), req.query as unknown as GridQuery));
  }),
);

productsRouter.put(
  '/grid',
  requirePermission('products', 'edit'),
  validate({ body: gridSaveSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as GridSave;
    const t = tenantOf(req);
    if (body.batches.length && !can(t.permissions, 'stock', 'edit')) throw AppError.forbidden('You can’t correct stock');
    const out = await saveGrid(t, await actorOf(req), body, req.ip);
    sent(res, out, 'Changes saved');
  }),
);

productsRouter.get(
  '/companies',
  view,
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.companies(tenantOf(req)));
  }),
);

productsRouter.get(
  '/import/template',
  requirePermission('products', 'create'),
  asyncHandler(async (_req: Request, res: Response) => {
    sendFile(res, await importTemplate(), 'MedBox24-product-import-template', 'xlsx');
  }),
);

// The Excel import's progress bar: rows saved so far of a running import.
productsRouter.get(
  '/import/progress/:id',
  requirePermission('products', 'create'),
  validate({ params: z.object({ id: clientRequestId }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await importProgress(tenantOf(req), String(req.params.id)));
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
    else fetched(res, sayNotes(langOf(req), out));
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
    const { stock } = body;
    created(res, stock ? await addWithStock(tenantOf(req), await actorOf(req), { ...body, stock }, req.ip) : await svc.create(tenantOf(req), await actorOf(req), body, req.ip), `${body.name} saved`);
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

// D111: sell price and lowest price from one dialog on the product page.
productsRouter.put(
  '/:id/prices',
  requirePermission('products', 'edit'),
  validate({ params: idParams, body: pricesSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.setPrices(tenantOf(req), await actorOf(req), idOf(req), req.body as PricesInput, req.ip), 'Prices saved');
  }),
);

const codeBody = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9-]{4,32}$/, 'A barcode has 4 to 32 letters or digits') }).strict();

productsRouter.post(
  '/:id/barcodes',
  requirePermission('products', 'edit'),
  validate({ params: idParams, body: codeBody }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.addBarcode(tenantOf(req), await actorOf(req), idOf(req), (req.body as { code: string }).code, req.ip), 'Barcode saved — next time it adds by itself');
  }),
);

productsRouter.delete(
  '/:id/barcodes/:code',
  requirePermission('products', 'edit'),
  validate({ params: idParams.extend({ code: z.string().regex(/^[A-Za-z0-9-]{4,32}$/) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.removeBarcode(tenantOf(req), await actorOf(req), idOf(req), (req.params as { code: string }).code, req.ip), 'Barcode removed');
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
