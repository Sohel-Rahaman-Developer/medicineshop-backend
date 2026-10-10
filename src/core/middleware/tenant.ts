import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { AppError } from '../errors';
import { checkSession, claimsOf } from './require-auth';
import { MembershipModel, type Membership } from '../../modules/memberships/membership.model';
import { effective, type Action, type Module, type Permissions, type Scopes, can } from '../../modules/rbac/permissions';
import { RoleModel, type Role } from '../../modules/roles/role.model';
import { ShopModel } from '../../modules/shops/shop.model';
import { SubscriptionModel, graceEndOf, isReadOnly, statusAt, type SubscriptionStatus } from '../../modules/subscription/subscription.model';
import { env } from '../../config/env';
import { platform } from '../../modules/admin/platform';

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
  // All four reads go out together; the membership brings its role along in the same query.
  const [[found], shop, sub] = await Promise.all([
    MembershipModel.aggregate<Membership & { _id: Types.ObjectId; role: (Role & { _id: Types.ObjectId })[] }>([
      { $match: { shopId, userId, status: 'active' } },
      { $limit: 1 },
      { $lookup: { from: RoleModel.collection.name, localField: 'roleId', foreignField: '_id', as: 'role', pipeline: [{ $match: { shopId } }] } },
    ]),
    ShopModel.findById(shopId).select('name status ownerUserId').lean(),
    SubscriptionModel.findOne({ shopId }).lean(),
    platform(),
  ]);
  // Same answer for "no such shop" and "not your shop": nothing about other tenants leaks.
  if (!found) throw AppError.forbidden('You do not have access to this shop');
  const { role: [role], ...membership } = found;
  if (!shop || !role || !sub) throw AppError.forbidden('You do not have access to this shop');
  if (shop.status !== 'active') throw AppError.forbidden('This shop is not active. Please contact MedBox24 support.');
  // The date moves the plan along (trial → grace → expired); the nightly job does the same for shops nobody opens.
  const status = statusAt(sub, new Date());
  if (status !== sub.status) await SubscriptionModel.updateOne({ shopId, _id: sub._id, status: sub.status }, { $set: { status, graceEndDate: graceEndOf(sub.endDate) } });
  const ctx: TenantContext = {
    shopId,
    shopName: shop.name,
    membershipId: membership._id,
    roleId: role._id,
    roleKey: role.systemKey ?? undefined,
    isOwner: role.systemKey === 'owner' && shop.ownerUserId.equals(userId),
    permissions: effective(role.permissions, membership.grants as Permissions, membership.denies as Permissions),
    scopes: role.scopes,
    subscription: { status, endDate: sub.endDate, maxUsers: sub.maxUsers },
  };
  return { ctx, membership };
}

// requireAuth and the shop in one step: the session and the shop are read together. The shop comes from X-Shop-Id
// and is trusted only with an active membership (PLAN §5); a dead session answers 401 whatever the shop says.
export const shopAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    const claims = claimsOf(req);
    const header = req.get('x-shop-id') ?? '';
    const shopId = Types.ObjectId.isValid(header) ? new Types.ObjectId(header) : null;
    const userId = new Types.ObjectId(claims.sub);
    const [session, shop] = await Promise.allSettled([checkSession(claims), shopId ? contextFor(shopId, userId) : Promise.reject(AppError.badRequest('Choose a shop first'))]);
    if (session.status === 'rejected') throw session.reason;
    if (shop.status === 'rejected') throw shop.reason;
    req.auth = { userId: claims.sub, sessionId: claims.sid };
    const { ctx, membership } = shop.value;
    // Paying for a plan is the one write a read-only shop must still make.
    if (isReadOnly(ctx.subscription.status) && !SAFE.has(req.method) && req.baseUrl !== `${env.API_PREFIX}/subscription`) {
      throw AppError.subscriptionRequired('Your plan has ended, so the shop is read-only. Choose a plan to continue.');
    }
    req.tenant = ctx;

    if (!membership.lastActiveAt || Date.now() - membership.lastActiveAt.getTime() > ACTIVE_TOUCH_MS) {
      MembershipModel.updateOne({ shopId: ctx.shopId, _id: membership._id }, { $set: { lastActiveAt: new Date() } })
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
