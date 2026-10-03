import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { MembershipModel } from '../memberships/membership.model';
import { RoleModel } from '../roles/role.model';
import { actorOf } from '../user/actor';
import * as svc from './shops.service';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { audit } from '../audit/audit.model';
import * as retention from '../retention/retention';
import { filesInfo, filesZipPlan, sendFilesZip } from '../attachments/files-zip';
import { TermsAcceptanceModel } from './terms-acceptance.model';
import { TERMS_POINTS } from './terms.content';
import { createShopSchema, updateShopSchema, type CreateShopInput, type UpdateShopInput } from './shops.validation';

export const shopsRouter = Router();
export const shopRouter = Router();

const ctxOf = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent') ?? undefined });

shopsRouter.get('/onboarding', requireAuth, asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.onboardingMeta()); }));

shopsRouter.post(
  '/',
  requireAuth,
  validate({ body: createShopSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const shop = await svc.createShop(req.auth?.userId ?? '', req.body as CreateShopInput, ctxOf(req));
    created(res, shop, 'Your shop is ready. The free trial has started.');
  }),
);

shopRouter.use(requireAuth, tenant);

shopRouter.get(
  '/context',
  asyncHandler(async (req: Request, res: Response) => {
    const t = tenantOf(req);
    const [role, m] = await Promise.all([
      RoleModel.findOne({ shopId: t.shopId, _id: t.roleId }).select('name').lean(),
      MembershipModel.findOne({ shopId: t.shopId, _id: t.membershipId }).select('designation').lean(),
    ]);
    fetched(res, svc.context(t, role?.name ?? '', m?.designation ?? ''));
  }),
);

const ownerOnly = (req: Request) => {
  const t = tenantOf(req);
  if (!t.isOwner) throw AppError.forbidden('Only the shop owner downloads all the photos');
  return t;
};
shopRouter.get('/files', asyncHandler(async (req: Request, res: Response) => { const { files, bytes, products, papers } = await filesInfo(ownerOnly(req).shopId); fetched(res, { files, bytes, products, papers }); }));
/** Every stored photo of this shop as one ZIP — the owner's own copy (D69). */
shopRouter.get(
  '/files.zip',
  asyncHandler(async (req: Request, res: Response) => {
    const t = ownerOnly(req);
    const plan = await filesZipPlan(t.shopId);
    const actor = await actorOf(req);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'share_initiated', module: 'settings', entityId: String(t.shopId), entityName: 'Photos ZIP', text: `${actor.name} downloaded all photos (${String(plan.files)} files)`, ip: req.ip });
    await sendFilesZip(res, t.shopId, plan);
  }),
);

shopRouter.get('/data', requirePermission('subscription', 'view'), asyncHandler(async (req: Request, res: Response) => { fetched(res, await retention.plan(tenantOf(req).shopId)); }));

shopRouter.get(
  '/terms',
  asyncHandler(async (req: Request, res: Response) => {
    const t = tenantOf(req);
    const last = await TermsAcceptanceModel.findOne({ shopId: t.shopId }).sort({ at: -1 }).lean();
    fetched(res, { version: env.TERMS_VERSION, accepted: last?.version === env.TERMS_VERSION, acceptedVersion: last?.version ?? null, acceptedAt: last?.at ?? null, acceptedBy: last?.userName ?? null, points: TERMS_POINTS, canAccept: t.isOwner });
  }),
);

shopRouter.post(
  '/terms/accept',
  validate({ body: z.object({ version: z.string().max(20) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const t = tenantOf(req);
    if (!t.isOwner) throw AppError.forbidden('Only the shop owner agrees to the Terms');
    if ((req.body as { version: string }).version !== env.TERMS_VERSION) throw AppError.conflict('The Terms changed again — reload and read the latest');
    const actor = await actorOf(req);
    await TermsAcceptanceModel.create({ shopId: t.shopId, version: env.TERMS_VERSION, userId: new Types.ObjectId(actor.id), userName: actor.name, ip: req.ip, userAgent: req.get('user-agent') });
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'settings', entityId: String(t.shopId), entityName: 'Terms', text: `${actor.name} agreed to the Terms (${env.TERMS_VERSION})`, ip: req.ip });
    sent(res, { version: env.TERMS_VERSION, accepted: true }, 'Thank you — Terms accepted');
  }),
);

shopRouter.get(
  '/',
  requirePermission('settings', 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.getProfile(tenantOf(req).shopId));
  }),
);

shopRouter.patch(
  '/',
  requirePermission('settings', 'edit'),
  validate({ body: updateShopSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await svc.updateProfile(tenantOf(req), await actorOf(req), req.body as UpdateShopInput, ctxOf(req));
    sent(res, profile, 'Shop profile saved');
  }),
);
