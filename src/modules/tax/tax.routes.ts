import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { actorOf } from '../user/actor';
import * as svc from './tax.service';
import { taxSettingsSchema, type TaxSettingsInput } from './tax.validation';

// D62: every member reads the list (the product form needs it); only settings:edit changes it.
export const taxRouter = Router();
taxRouter.use(shopAuth);

taxRouter.get('/', asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.taxSettings(tenantOf(req))); }));

taxRouter.put(
  '/',
  requirePermission('settings', 'edit'),
  validate({ body: taxSettingsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.saveTaxSettings(tenantOf(req), await actorOf(req), req.body as TaxSettingsInput, req.ip), 'Tax settings saved');
  }),
);
