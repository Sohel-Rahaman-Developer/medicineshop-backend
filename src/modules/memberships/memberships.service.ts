import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { audit } from '../audit/audit.model';
import { RoleModel } from '../roles/role.model';
import { ShopModel } from '../shops/shop.model';
import { SubscriptionModel } from '../subscription/subscription.model';
import { UserModel } from '../user/user.model';
import { MembershipModel } from './membership.model';

const byId = <T extends { _id: Types.ObjectId }>(rows: T[]) => new Map(rows.map((r) => [String(r._id), r]));

/** Shops the user can enter right now — shown on the shop picker and in the account page. */
export async function myShops(userId: string) {
  const uid = new Types.ObjectId(userId);
  const ms = await MembershipModel.find({ userId: uid, status: 'active' }).setOptions({ crossTenant: true }).lean();
  if (!ms.length) return [];
  const shopIds = ms.map((m) => m.shopId);
  const [shops, roles, subs] = await Promise.all([
    ShopModel.find({ _id: { $in: shopIds }, status: 'active' }).select('name address.city address.line2').lean(),
    RoleModel.find({ shopId: { $in: shopIds }, _id: { $in: ms.map((m) => m.roleId) } }).select('name systemKey color').lean(),
    SubscriptionModel.find({ shopId: { $in: shopIds } }).select('shopId status endDate').lean(),
  ]);
  const shopMap = byId(shops);
  const roleMap = byId(roles);
  const subMap = new Map(subs.map((s) => [String(s.shopId), s]));
  return ms.flatMap((m) => {
    const shop = shopMap.get(String(m.shopId));
    const role = roleMap.get(String(m.roleId));
    const sub = subMap.get(String(m.shopId));
    if (!shop || !role || !sub) return [];
    return [{
      shopId: String(shop._id),
      shopName: shop.name,
      place: [shop.address?.line2, shop.address?.city].filter(Boolean).join(', '),
      roleName: role.name,
      designation: m.designation,
      isOwner: role.systemKey === 'owner',
      subscription: { status: sub.status, endDate: sub.endDate },
    }];
  });
}

/** Pending invitations: shop name, role and who invited — nothing else about the shop before Accept (D31). */
export async function myInvitations(userId: string) {
  const uid = new Types.ObjectId(userId);
  const ms = await MembershipModel.find({ userId: uid, status: 'invited' }).setOptions({ crossTenant: true }).lean();
  if (!ms.length) return [];
  const [shops, roles, inviters] = await Promise.all([
    ShopModel.find({ _id: { $in: ms.map((m) => m.shopId) } }).select('name status').lean(),
    RoleModel.find({ shopId: { $in: ms.map((m) => m.shopId) }, _id: { $in: ms.map((m) => m.roleId) } }).select('name').lean(),
    UserModel.find({ _id: { $in: ms.flatMap((m) => (m.invitedBy ? [m.invitedBy] : [])) } }).select('name email').lean(),
  ]);
  const shopMap = byId(shops);
  const roleMap = byId(roles);
  const userMap = byId(inviters);
  return ms.flatMap((m) => {
    const shop = shopMap.get(String(m.shopId));
    if (!shop || shop.status !== 'active') return [];
    const inviter = m.invitedBy ? userMap.get(String(m.invitedBy)) : undefined;
    return [{
      id: String(m._id),
      shopName: shop.name,
      roleName: m.designation || roleMap.get(String(m.roleId))?.name || '',
      invitedBy: inviter?.name || inviter?.email || '',
      invitedAt: m.invitedAt,
    }];
  });
}

async function pendingFor(userId: string, id: string) {
  const m = await MembershipModel.findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId), status: 'invited' })
    .setOptions({ crossTenant: true });
  if (!m) throw AppError.notFound('This invitation is no longer open');
  const shop = await ShopModel.findById(m.shopId).select('name status').lean();
  if (!shop || shop.status !== 'active') throw AppError.notFound('This invitation is no longer open');
  return { m, shop };
}

export async function accept(userId: string, id: string, profile: { name: string; phone?: string }, ip?: string) {
  const { m, shop } = await pendingFor(userId, id);
  await UserModel.updateOne({ _id: m.userId }, { $set: { name: profile.name, ...(profile.phone ? { phone: profile.phone } : {}) } });
  const now = new Date();
  m.set({ status: 'active', joinedAt: now, lastActiveAt: now });
  await m.save();
  await audit({ shopId: m.shopId, userId, userName: profile.name, action: 'update', module: 'staff', entityId: String(m._id), entityName: profile.name, text: `${profile.name} accepted the invitation`, ip });
  return { shopId: String(m.shopId), shopName: shop.name };
}

export async function decline(userId: string, id: string, userName: string, ip?: string) {
  const { m } = await pendingFor(userId, id);
  m.set({ status: 'declined', declinedAt: new Date() });
  await m.save();
  await audit({ shopId: m.shopId, userId, userName, action: 'update', module: 'staff', entityId: String(m._id), entityName: userName, text: `${userName} declined the invitation`, ip });
}
