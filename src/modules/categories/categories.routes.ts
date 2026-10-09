import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as svc from './categories.service';

export const categoriesRouter = Router();
categoriesRouter.use(shopAuth);

const createSchema = z.object({ name: z.string().trim().min(2, 'Give the category a name').max(40).transform((v) => v.replace(/\s+/g, ' ')) }).strict();

categoriesRouter.get(
  '/',
  requirePermission('products', 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.list(tenantOf(req)));
  }),
);

categoriesRouter.post(
  '/',
  requirePermission('settings', 'edit'),
  validate({ body: createSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await svc.create(tenantOf(req), await actorOf(req), (req.body as z.infer<typeof createSchema>).name, req.ip);
    created(res, out, `Category “${out.name}” added`);
  }),
);

categoriesRouter.delete(
  '/:id',
  requirePermission('settings', 'edit'),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.remove(tenantOf(req), await actorOf(req), (req.params as { id: string }).id, req.ip);
    sent(res, null, 'Category removed');
  }),
);
