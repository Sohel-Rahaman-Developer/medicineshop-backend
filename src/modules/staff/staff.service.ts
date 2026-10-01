import { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { versionOf } from '../../core/version';
import { sendMail } from '../../services/mailer';
import { inviteEmail } from '../../services/email-templates';
import { listActiveSessions, revokeAllForUser } from '../auth/token.service';
import { audit } from '../audit/audit.model';
import { MembershipModel, type MembershipDoc } from '../memberships/membership.model';
import { assertCanGrant, assertCanGrantScopes, effective, MODULES, type Permissions, type Scopes } from '../rbac/permissions';
import { RoleModel } from '../roles/role.model';
import type { Actor } from '../user/actor';
import { UserModel } from '../user/user.model';
import type { InviteInput, UpdateMemberInput } from './staff.validation';

const SEATED = ['active', 'invited', 'suspended'] as const;

function subset(inner: Permissions, outer: Permissions): boolean {
  return MODULES.every((m) => (inner[m] ?? []).every((a) => outer[m]?.includes(a)));
}

async function roleIn(t: TenantContext, roleId: string) {
  const role = await RoleModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(roleId) }).lean();
  if (!role) throw AppError.notFound('Role not found');
  if (role.systemKey === 'owner') throw AppError.forbidden('A shop has only one owner');
  return role;
}

function assertCanAssign(t: TenantContext, role: { permissions: unknown; scopes: unknown }, grants: Permissions) {
  assertCanGrant(t.permissions, t.isOwner, effective(role.permissions as Permissions, grants));
  assertCanGrantScopes(t.scopes, t.isOwner, role.scopes as Scopes);
}

async function target(t: TenantContext, actor: Actor, id: string): Promise<MembershipDoc> {
  const m = await MembershipModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), status: { $ne: 'removed' } });
  if (!m) throw AppError.notFound('Staff member not found');
  const role = await RoleModel.findOne({ shopId: t.shopId, _id: m.roleId }).lean();
  if (role?.systemKey === 'owner') throw AppError.forbidden("The owner's access can't be changed");
  if (m.userId.equals(actor.id)) throw AppError.forbidden("You can't change your own access");
  const theirs = effective((role?.permissions ?? {}) as Permissions, m.grants as Permissions, m.denies as Permissions);
  if (!t.isOwner && !subset(theirs, t.permissions)) throw AppError.forbidden('This person has more access than you');
  return m;
}

async function assertSeatFree(t: TenantContext) {
  const used = await MembershipModel.countDocuments({ shopId: t.shopId, status: { $in: SEATED } });
  if (used >= t.subscription.maxUsers) {
    throw AppError.conflict(`Your plan allows ${t.subscription.maxUsers} users and all are taken. Remove someone or choose a bigger plan.`);
  }
}

/** Roles this person may hand out: never the owner role, and nothing above their own access. */
export async function assignableRoles(t: TenantContext) {
  const roles = await RoleModel.find({ shopId: t.shopId, systemKey: { $ne: 'owner' } }).sort({ isSystem: -1, createdAt: 1 }).lean();
  return roles.map((r) => {
    let assignable = true;
    try {
      assertCanAssign(t, r, {});
    } catch {
      assignable = false;
    }
    return { id: String(r._id), name: r.name, color: r.color, key: r.systemKey ?? null, permissions: r.permissions as Permissions, assignable };
  });
}

export async function list(t: TenantContext) {
  const ms = await MembershipModel.find({ shopId: t.shopId, status: { $ne: 'removed' } }).sort({ createdAt: 1 }).lean();
  const [users, roles, used] = await Promise.all([
    UserModel.find({ _id: { $in: ms.map((m) => m.userId) } }).select('name email phone').lean(),
    RoleModel.find({ shopId: t.shopId }).select('name color systemKey').lean(),
    MembershipModel.countDocuments({ shopId: t.shopId, status: { $in: SEATED } }),
  ]);
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const roleMap = new Map(roles.map((r) => [String(r._id), r]));
  return {
    seats: { used, max: t.subscription.maxUsers },
    members: ms.map((m) => {
      const u = userMap.get(String(m.userId));
      const r = roleMap.get(String(m.roleId));
      return {
        id: String(m._id),
        name: u?.name || u?.email || '',
        email: u?.email ?? '',
        phone: u?.phone,
        role: { id: String(m.roleId), name: r?.name ?? '', color: r?.color ?? '', key: r?.systemKey ?? null },
        designation: m.designation,
        status: m.status,
        invitedAt: m.invitedAt,
        joinedAt: m.joinedAt,
        lastActiveAt: m.lastActiveAt,
        isOwner: r?.systemKey === 'owner',
      };
    }),
  };
}

export async function detail(t: TenantContext, id: string) {
  const m = await MembershipModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), status: { $ne: 'removed' } }).lean();
  if (!m) throw AppError.notFound('Staff member not found');
  const [user, role] = await Promise.all([
    UserModel.findById(m.userId).select('name email phone').lean(),
    RoleModel.findOne({ shopId: t.shopId, _id: m.roleId }).lean(),
  ]);
  const grants = m.grants as Permissions;
  const denies = m.denies as Permissions;
  const devices = m.status === 'active' ? await listActiveSessions(m.userId) : [];
  return {
    id: String(m._id),
    name: user?.name || user?.email || '',
    email: user?.email ?? '',
    phone: user?.phone,
    role: { id: String(m.roleId), name: role?.name ?? '', key: role?.systemKey ?? null },
    designation: m.designation,
    status: m.status,
    grants,
    denies,
    effective: effective((role?.permissions ?? {}) as Permissions, grants, denies),
    invitedAt: m.invitedAt,
    joinedAt: m.joinedAt,
    lastActiveAt: m.lastActiveAt,
    isOwner: role?.systemKey === 'owner',
    version: (m as { version?: number }).version ?? 0,
    devices: devices.map((s) => ({ id: String(s._id), userAgent: s.userAgent, lastUsedAt: s.lastUsedAt })),
  };
}

export async function invite(t: TenantContext, actor: Actor, input: InviteInput, ip?: string) {
  const role = await roleIn(t, input.roleId);
  const grants = input.grants ?? {};
  assertCanAssign(t, role, grants);

  const user =
    (await UserModel.findOne({ email: input.email })) ??
    (await UserModel.create({ email: input.email, name: input.name, phone: input.phone }));
  if (user.status !== 'active') throw AppError.conflict('This email address can’t be invited. Please contact MedShop support.');
  if (!user.name) await UserModel.updateOne({ _id: user._id }, { $set: { name: input.name } });

  const existing = await MembershipModel.findOne({ shopId: t.shopId, userId: user._id });
  if (existing && existing.status !== 'declined' && existing.status !== 'removed') {
    throw AppError.conflict(existing.status === 'invited' ? 'This person is already invited' : 'This person is already on your staff');
  }
  await assertSeatFree(t);

  const fields = {
    roleId: role._id,
    designation: input.designation ?? '',
    grants,
    denies: input.denies ?? {},
    status: 'invited' as const,
    invitedBy: new Types.ObjectId(actor.id),
    invitedAt: new Date(),
  };
  const m = existing ?? new MembershipModel({ shopId: t.shopId, userId: user._id });
  m.set({ ...fields, declinedAt: undefined, removedAt: undefined, removedBy: undefined });
  await m.save();

  const mail = inviteEmail({ shopName: t.shopName, roleName: input.designation || role.name, inviterName: actor.name, appUrl: env.SHOP_APP_URL });
  sendMail({ to: input.email, ...mail }).catch((err: unknown) => {
    logger.error({ err }, 'Invite email failed');
  });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'staff', entityId: String(m._id), entityName: input.name, text: `${actor.name} invited ${input.name} (${input.email}) as ${role.name}`, ip });
  return { id: String(m._id) };
}

export async function update(t: TenantContext, actor: Actor, id: string, input: UpdateMemberInput, ip?: string) {
  const m = await target(t, actor, id);
  if (versionOf(m) !== input.version) throw AppError.conflict('Someone else changed this person’s access. Reload to see the latest.');
  const role = await roleIn(t, input.roleId);
  assertCanAssign(t, role, input.grants);
  const before = { roleId: String(m.roleId), designation: m.designation, grants: m.grants as unknown, denies: m.denies as unknown };
  m.set({ roleId: role._id, designation: input.designation, grants: input.grants, denies: input.denies });
  await m.save();
  const user = await UserModel.findById(m.userId).select('name email').lean();
  const name = user?.name || user?.email || '';
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'permission_change', module: 'staff', entityId: id, entityName: name, text: `${actor.name} changed ${name}'s access (role ${role.name})`, changes: { before, after: { roleId: input.roleId, designation: input.designation, grants: input.grants, denies: input.denies } }, ip });
}

export async function act(t: TenantContext, actor: Actor, id: string, action: 'suspend' | 'reactivate' | 'remove' | 'reinvite' | 'sign-out', ip?: string) {
  const m = await target(t, actor, id);
  const user = await UserModel.findById(m.userId).select('name email').lean();
  const name = user?.name || user?.email || '';
  const now = new Date();
  let text: string;
  let message: string;
  switch (action) {
    case 'suspend':
      if (m.status !== 'active') throw AppError.conflict('Only active staff can be suspended');
      m.set({ status: 'suspended', suspendedAt: now });
      text = `${actor.name} suspended ${name}`;
      message = `${name} is suspended and signed out of every device`;
      break;
    case 'reactivate':
      if (m.status !== 'suspended') throw AppError.conflict('Only suspended staff can be reactivated');
      m.set({ status: 'active', suspendedAt: undefined });
      text = `${actor.name} reactivated ${name}`;
      message = `${name} can sign in again`;
      break;
    case 'remove':
      m.set({ status: 'removed', removedAt: now, removedBy: new Types.ObjectId(actor.id) });
      text = `${actor.name} removed ${name} from the shop`;
      message = `${name} was removed and signed out of every device`;
      break;
    case 'reinvite':
      if (m.status !== 'declined') throw AppError.conflict('Only a declined invitation can be sent again');
      await assertSeatFree(t);
      m.set({ status: 'invited', invitedAt: now, invitedBy: new Types.ObjectId(actor.id), declinedAt: undefined });
      text = `${actor.name} invited ${name} again`;
      message = `Invitation sent to ${user?.email ?? name} again`;
      break;
    case 'sign-out':
      text = `${actor.name} signed ${name} out of every device`;
      message = `${name} is signed out of every device`;
      break;
  }
  if (action !== 'sign-out') await m.save();
  if (action === 'suspend' || action === 'remove' || action === 'sign-out') {
    await revokeAllForUser(m.userId, action === 'sign-out' ? 'user_revoked' : 'membership_removed');
  }
  if (action === 'reinvite' && user) {
    const role = await RoleModel.findOne({ shopId: t.shopId, _id: m.roleId }).select('name').lean();
    sendMail({ to: user.email, ...inviteEmail({ shopName: t.shopName, roleName: m.designation || role?.name || '', inviterName: actor.name, appUrl: env.SHOP_APP_URL }) }).catch(
      (err: unknown) => {
        logger.error({ err }, 'Invite email failed');
      },
    );
  }
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: action === 'remove' ? 'delete' : 'update', module: 'staff', entityId: id, entityName: name, text, ip });
  return message;
}
