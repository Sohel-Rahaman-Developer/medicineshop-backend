import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { versionOf } from '../../core/version';
import { audit } from '../audit/audit.model';
import { MembershipModel } from '../memberships/membership.model';
import { assertCanGrant, assertCanGrantScopes, MODULES, type Permissions, type Scopes } from '../rbac/permissions';
import type { Actor } from '../user/actor';
import { RoleModel } from './role.model';
import type { CreateRoleInput, UpdateRoleInput } from './roles.validation';

const shape = (r: { _id: Types.ObjectId; name: string; description?: string | null; color: string; permissions: unknown; scopes: unknown; isSystem: boolean; systemKey?: string | null; version?: number }) => ({
  id: String(r._id),
  name: r.name,
  description: r.description ?? '',
  color: r.color,
  permissions: r.permissions as Permissions,
  scopes: r.scopes as Scopes,
  isSystem: r.isSystem,
  key: r.systemKey ?? null,
  version: r.version ?? 0,
});

function assertAllowed(t: TenantContext, permissions: Permissions, scopes: Scopes) {
  assertCanGrant(t.permissions, t.isOwner, permissions);
  assertCanGrantScopes(t.scopes, t.isOwner, scopes);
}

const conflictOnDuplicate = (err: unknown): never => {
  if ((err as { code?: number }).code === 11000) throw AppError.conflict('A role with this name already exists');
  throw err;
};

export async function list(t: TenantContext) {
  const [roles, counts] = await Promise.all([
    RoleModel.find({ shopId: t.shopId }).sort({ isSystem: -1, createdAt: 1 }).lean(),
    MembershipModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { shopId: t.shopId, status: { $in: ['active', 'invited', 'suspended'] } } },
      { $group: { _id: '$roleId', n: { $sum: 1 } } },
    ]),
  ]);
  const count = new Map(counts.map((c) => [String(c._id), c.n]));
  return roles.map((r) => ({ ...shape(r), members: count.get(String(r._id)) ?? 0 }));
}

export async function get(t: TenantContext, id: string) {
  const r = await RoleModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) }).lean();
  if (!r) throw AppError.notFound('Role not found');
  return shape(r);
}

export async function create(t: TenantContext, actor: Actor, input: CreateRoleInput, ip?: string) {
  assertAllowed(t, input.permissions, input.scopes);
  const role = await RoleModel.create({ shopId: t.shopId, ...input, nameLower: input.name.toLowerCase(), isSystem: false, createdBy: new Types.ObjectId(actor.id) }).catch(conflictOnDuplicate);
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'permission_change', module: 'roles', entityId: String(role._id), entityName: role.name, text: `${actor.name} created role “${role.name}”`, ip });
  return { id: String(role._id) };
}

export async function update(t: TenantContext, actor: Actor, id: string, input: UpdateRoleInput, ip?: string) {
  const role = await RoleModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) });
  if (!role) throw AppError.notFound('Role not found');
  if (role.isSystem) throw AppError.forbidden('Built-in roles can’t be changed. Duplicate it to make your own.');
  if (versionOf(role) !== input.version) throw AppError.conflict('Someone else changed this role. Reload to see the latest.');
  const current = role.permissions as Permissions;
  if (!t.isOwner && MODULES.some((m) => (current[m] ?? []).some((a) => !t.permissions[m]?.includes(a)))) {
    throw AppError.forbidden('This role has more access than you, so you can’t change it');
  }
  assertAllowed(t, input.permissions, input.scopes);
  const before = shape(role);
  role.set({ name: input.name, nameLower: input.name.toLowerCase(), description: input.description, color: input.color, permissions: input.permissions, scopes: input.scopes });
  role.markModified('permissions');
  role.markModified('scopes');
  await role.save().catch(conflictOnDuplicate);
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'permission_change', module: 'roles', entityId: id, entityName: role.name, text: `${actor.name} changed permissions of “${role.name}”`, changes: { before, after: shape(role) }, ip });
}

export async function remove(t: TenantContext, actor: Actor, id: string, ip?: string) {
  const role = await RoleModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) }).lean();
  if (!role) throw AppError.notFound('Role not found');
  if (role.isSystem) throw AppError.forbidden('Built-in roles can’t be deleted');
  const inUse = await MembershipModel.countDocuments({ shopId: t.shopId, roleId: role._id, status: { $ne: 'removed' } });
  if (inUse) throw AppError.conflict(`${inUse} staff ${inUse === 1 ? 'member has' : 'members have'} this role. Give them another role first.`);
  await RoleModel.deleteOne({ shopId: t.shopId, _id: role._id });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'delete', module: 'roles', entityId: id, entityName: role.name, text: `${actor.name} deleted role “${role.name}”`, ip });
}
