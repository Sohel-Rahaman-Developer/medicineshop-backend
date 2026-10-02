import mongoose, { Types } from 'mongoose';
import { platform } from '../admin/platform';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { versionOf } from '../../core/version';
import { STATES, stateCodeOf } from '../../utils/india';
import { audit } from '../audit/audit.model';
import { seedSystemCategories } from '../categories/category.model';
import { MembershipModel } from '../memberships/membership.model';
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from '../rbac/permissions';
import { RoleModel } from '../roles/role.model';
import { SubscriptionModel } from '../subscription/subscription.model';
import { UserModel } from '../user/user.model';
import { ShopModel } from './shop.model';
import type { CreateShopInput, UpdateShopInput } from './shops.validation';
import { TERMS_POINTS } from './terms.content';
import { TermsAcceptanceModel } from './terms-acceptance.model';

interface Ctx {
  ip?: string;
  userAgent?: string;
}

export async function onboardingMeta() {
  return {
    terms: { version: env.TERMS_VERSION, points: TERMS_POINTS },
    states: STATES.map((s) => s.name),
    trialDays: (await platform()).trialDays,
  };
}

const DAY = 24 * 60 * 60 * 1000;

export async function createShop(userId: string, input: CreateShopInput, ctx: Ctx) {
  const trial = await platform();
  if (input.termsVersion !== env.TERMS_VERSION) {
    throw AppError.conflict('The Terms have changed. Please read and agree to the new version.');
  }
  const uid = new Types.ObjectId(userId);
  const { shop: s, owner } = input;
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const user = await UserModel.findByIdAndUpdate(uid, { $set: { name: owner.name, phone: owner.phone } }, { session, returnDocument: 'after' });
      if (!user) throw AppError.unauthenticated();

      const [shop] = await ShopModel.create(
        [
          {
            name: s.name,
            legalName: s.name,
            ownerUserId: uid,
            address: { ...s.address, stateCode: stateCodeOf(s.address.state) },
            phone: s.phone,
            email: s.email,
            gstin: s.gstin,
            pan: s.pan,
            fssai: s.fssai,
            drugLicenseNumber: s.drugLicenseNumber,
            drugLicenseExpiry: s.drugLicenseExpiry,
            settings: { tax: { pricingMode: s.pricingMode } },
          },
        ],
        { session },
      );
      if (!shop) throw AppError.internal();
      const shopId = shop._id;

      const roles = await RoleModel.create(
        SYSTEM_ROLE_KEYS.map((key) => ({
          shopId,
          systemKey: key,
          name: SYSTEM_ROLES[key].name,
          nameLower: SYSTEM_ROLES[key].name.toLowerCase(),
          color: SYSTEM_ROLES[key].color,
          permissions: SYSTEM_ROLES[key].permissions,
          scopes: SYSTEM_ROLES[key].scopes,
          isSystem: true,
          createdBy: uid,
        })),
        { session, ordered: true },
      );
      const ownerRole = roles.find((r) => r.systemKey === 'owner');
      if (!ownerRole) throw AppError.internal();

      const now = new Date();
      await MembershipModel.create(
        [{ shopId, userId: uid, roleId: ownerRole._id, designation: 'Owner', status: 'active', joinedAt: now, lastActiveAt: now }],
        { session },
      );
      await SubscriptionModel.create(
        [{ shopId, planCode: 'trial', status: 'trial', startDate: now, endDate: new Date(now.getTime() + trial.trialDays * DAY), maxUsers: trial.trialMaxUsers }],
        { session },
      );
      await seedSystemCategories(shopId, session);
      await TermsAcceptanceModel.create(
        [{ shopId, version: env.TERMS_VERSION, userId: uid, userName: owner.name, ip: ctx.ip, userAgent: ctx.userAgent }],
        { session },
      );
      await audit({ shopId, userId: uid, userName: owner.name, action: 'create', module: 'settings', entityId: String(shopId), entityName: s.name, text: `${owner.name} created the shop and accepted the Terms (${env.TERMS_VERSION})`, ip: ctx.ip }, session);

      return { id: String(shopId), name: shop.name };
    });
  } finally {
    await session.endSession();
  }
}

export function context(t: TenantContext, roleName: string, designation: string) {
  return {
    shop: { id: String(t.shopId), name: t.shopName },
    role: { id: String(t.roleId), name: roleName, key: t.roleKey ?? null },
    designation,
    isOwner: t.isOwner,
    permissions: t.permissions,
    scopes: t.scopes,
    subscription: t.subscription,
  };
}

export async function getProfile(shopId: Types.ObjectId) {
  const shop = await ShopModel.findById(shopId)
    .select('name legalName address phone email gstin pan fssai drugLicenseNumber drugLicenseExpiry financialYearStartMonth version')
    .lean();
  if (!shop) throw AppError.notFound('Shop not found');
  const { _id, ...rest } = shop;
  return { id: String(_id), ...rest };
}

export async function updateProfile(t: TenantContext, actor: { id: string; name: string }, input: UpdateShopInput, ctx: Ctx) {
  const shop = await ShopModel.findById(t.shopId);
  if (!shop) throw AppError.notFound('Shop not found');
  if (versionOf(shop) !== input.version) throw AppError.conflict('Someone else changed the shop profile. Reload to see the latest.');
  const before = await getProfile(t.shopId);
  shop.set({
    name: input.name,
    legalName: input.legalName,
    address: { ...input.address, line2: input.address.line2 ?? '', stateCode: stateCodeOf(input.address.state) },
    phone: input.phone,
    email: input.email,
    gstin: input.gstin,
    pan: input.pan,
    fssai: input.fssai,
    drugLicenseNumber: input.drugLicenseNumber,
    drugLicenseExpiry: input.drugLicenseExpiry,
  });
  await shop.save();
  const after = await getProfile(t.shopId);
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'settings', entityName: 'Shop profile', text: `${actor.name} updated the shop profile`, changes: { before, after }, ip: ctx.ip });
  return after;
}
