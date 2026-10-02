import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { AppError } from '../errors';
import { MembershipModel } from '../../modules/memberships/membership.model';
import { effective, type Action, type Module, type Permissions, type Scopes, can } from '../../modules/rbac/permissions';
import { RoleModel } from '../../modules/roles/role.model';
import { ShopModel } from '../../modules/shops/shop.model';
import { SubscriptionModel, isReadOnly, type SubscriptionStatus } from '../../modules/subscription/subscription.model';

export interface TenantContext {
  shopId: Types.ObjectId;
  shopName: string;
  membershipId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleKey?: string;
  isOwner: boolean;
  permissions: Permissions;
  scopes: Scopes;
  subscription: { status: SubscriptionStatus; endDate: Date; maxUsers: number };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

const ACTIVE_TOUCH_MS = 5 * 60 * 1000;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** One person's view of one shop: active membership, role, grants and the plan. Background jobs use it too (B6). */
export async function contextFor(shopId: Types.ObjectId, userId: Types.ObjectId) {
  const membership = await MembershipModel.findOne({ shopId, userId, status: 'active' }).lean();
  // Same answer for "no such shop" and "not your shop": nothing about other tenants leaks.
  if (!membership) throw AppError.forbidden('You do not have access to this shop');
  const [shop, role, sub] = await Promise.all([
    ShopModel.findById(shopId).select('name status ownerUserId').lean(),
    RoleModel.findOne({ shopId, _id: membership.roleId }).lean(),
    SubscriptionModel.findOne({ shopId }).lean(),
  ]);
  if (!shop || !role || !sub) throw AppError.forbidden('You do not have access to this shop');
  if (shop.status !== 'active') throw AppError.forbidden('This shop is not active. Please contact MedShop support.');
  const ctx: TenantContext = {
    shopId,
    shopName: shop.name,
    membershipId: membership._id,
    roleId: role._id,
    roleKey: role.systemKey ?? undefined,
    isOwner: role.systemKey === 'owner' && shop.ownerUserId.equals(userId),
    permissions: effective(role.permissions as Permissions, membership.grants as Permissions, membership.denies as Permissions),
    scopes: role.scopes as Scopes,
    subscription: { status: sub.status, endDate: sub.endDate, maxUsers: sub.maxUsers },
  };
  return { ctx, membership };
}

// Runs after requireAuth. The shop comes from X-Shop-Id and is trusted only with an active membership (PLAN §5).
export const tenant: RequestHandler = (req, _res, next) => {
  void (async () => {
    if (!req.auth) throw AppError.unauthenticated();
    const header = req.get('x-shop-id') ?? '';
    if (!Types.ObjectId.isValid(header)) throw AppError.badRequest('Choose a shop first');
    const shopId = new Types.ObjectId(header);
    const userId = new Types.ObjectId(req.auth.userId);
    const { ctx, membership } = await contextFor(shopId, userId);
    if (isReadOnly(ctx.subscription.status) && !SAFE.has(req.method)) {
      throw AppError.subscriptionRequired('Your plan has ended, so the shop is read-only. Choose a plan to continue.');
    }
    req.tenant = ctx;

    if (!membership.lastActiveAt || Date.now() - membership.lastActiveAt.getTime() > ACTIVE_TOUCH_MS) {
      MembershipModel.updateOne({ shopId, _id: membership._id }, { $set: { lastActiveAt: new Date() } })
        .exec()
        .catch(() => undefined);
    }
  })().then(() => {
    next();
  }, next);
};

export const requirePermission =
  (module: Module, action: Action): RequestHandler =>
  (req, _res, next) => {
    if (!req.tenant) return next(AppError.internal());
    if (!can(req.tenant.permissions, module, action)) return next(AppError.forbidden());
    next();
  };

export function tenantOf(req: Express.Request): TenantContext {
  if (!req.tenant) throw AppError.internal('Tenant middleware did not run');
  return req.tenant;
}
