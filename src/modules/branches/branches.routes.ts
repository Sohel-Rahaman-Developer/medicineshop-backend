import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { notInDemo, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched } from '../../core/response';
import { GSTIN_RE } from '../../utils/india';
import { gstinMatchesState, gstinMessage, shopFields, upper } from '../shops/shops.validation';
import { actorOf } from '../user/actor';
import * as svc from './branches.service';

const branchBody = z
  .object({
    name: shopFields.name,
    address: shopFields.address,
    phone: shopFields.phone,
    email: shopFields.email,
    drugLicenseNumber: shopFields.drugLicenseNumber,
    drugLicenseExpiry: shopFields.drugLicenseExpiry,
    fssai: shopFields.fssai,
    gst: z.enum(['main', 'own'], 'Choose the GSTIN'),
    gstin: upper(GSTIN_RE, 'GSTIN looks wrong — 15 characters, like 19ABCDE1234F1Z5'),
    billPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,6}$/, 'Bill series: 2 to 6 letters or numbers, like SLT'),
  })
  .strict()
  .refine((b) => b.gst === 'main' || gstinMatchesState(b), gstinMessage);

// v1.25: the owner's branches — today in each, and opening a new one from the main shop.
export const branchesRouter = Router();
branchesRouter.use(shopAuth);

branchesRouter.get('/', asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.overview(tenantOf(req), await actorOf(req))); }));
branchesRouter.post('/', notInDemo, validate({ body: branchBody }), asyncHandler(async (req: Request, res: Response) => {
  const b = req.body as svc.BranchInput;
  const out = await svc.create(tenantOf(req), await actorOf(req), b, req.ip);
  created(res, out, `${out.name} is open — ${String(out.copied)} medicines copied, stock starts at 0`);
}));
