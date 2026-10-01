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
import { createShopSchema, updateShopSchema, type CreateShopInput, type UpdateShopInput } from './shops.validation';

export const shopsRouter = Router();
export const shopRouter = Router();

const ctxOf = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent') ?? undefined });

shopsRouter.get('/onboarding', requireAuth, (_req, res) => {
  fetched(res, svc.onboardingMeta());
});

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
