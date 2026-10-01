import { z } from 'zod';
import { AppError } from '../../core/errors';

export const MODULES = [
  'dashboard', 'pos', 'sales', 'purchases', 'products', 'stock', 'suppliers', 'customers',
  'loyalty', 'expenses', 'reports', 'staff', 'roles', 'settings', 'subscription', 'notifications',
] as const;
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'approve'] as const;

export type Module = (typeof MODULES)[number];
export type Action = (typeof ACTIONS)[number];
export type Permissions = Partial<Record<Module, Action[]>>;
export type Scope = 'own' | 'shop';
export type Scopes = Partial<Record<Module, Scope>>;

export const permissionsSchema = z
  .partialRecord(z.enum(MODULES), z.array(z.enum(ACTIONS)).max(ACTIONS.length))
  .transform((p) => normalize(p));

export const SYSTEM_ROLE_KEYS = ['owner', 'manager', 'cashier', 'stockKeeper', 'accountant'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

const LETTER: Record<string, Action> = { V: 'view', C: 'create', E: 'edit', D: 'delete', X: 'export', A: 'approve' };
const expand = (m: Partial<Record<Module, string>>): Permissions =>
  normalize(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Array.from(v, (l) => LETTER[l] as Action)])));

// PLAN §7 default matrix, same as sandbox/shop/js/rbac.js.
export const SYSTEM_ROLES: Record<SystemRoleKey, { name: string; color: string; permissions: Permissions; scopes: Scopes }> = {
  owner: {
    name: 'Owner',
    color: '#0fb5a8',
    permissions: expand({ dashboard: 'V', pos: 'VC', sales: 'VCEDXA', purchases: 'VCEDXA', products: 'VCEDX', stock: 'VCEDXA', suppliers: 'VCEDX', customers: 'VCEDX', loyalty: 'VCEDX', expenses: 'VCEDX', reports: 'VX', staff: 'VCEDX', roles: 'VCED', settings: 'VCED', subscription: 'VCED', notifications: 'VE' }),
    scopes: {},
  },
  manager: {
    name: 'Manager',
    color: '#6366f1',
    permissions: expand({ dashboard: 'V', pos: 'VC', sales: 'VCEXA', purchases: 'VCEXA', products: 'VCEDX', stock: 'VCEXA', suppliers: 'VCEX', customers: 'VCEX', loyalty: 'VCEX', expenses: 'VCEX', reports: 'VX', staff: 'VCE', roles: 'VE', settings: 'VE', subscription: 'V', notifications: 'VE' }),
    scopes: {},
  },
  cashier: {
    name: 'Pharmacist / Cashier',
    color: '#10b981',
    permissions: expand({ dashboard: 'V', pos: 'VC', sales: 'V', products: 'V', stock: 'V', customers: 'VCE', loyalty: 'VC', notifications: 'V' }),
    scopes: { sales: 'own' },
  },
  stockKeeper: {
    name: 'Stock Keeper',
    color: '#0ea5e9',
    permissions: expand({ dashboard: 'V', purchases: 'VCE', products: 'VCEX', stock: 'VCEX', suppliers: 'VCE', reports: 'V', notifications: 'V' }),
    scopes: {},
  },
  accountant: {
    name: 'Accountant',
    color: '#f59e0b',
    permissions: expand({ dashboard: 'V', sales: 'VX', purchases: 'VX', products: 'V', stock: 'V', suppliers: 'VX', customers: 'VX', loyalty: 'V', expenses: 'VCEX', reports: 'VX', notifications: 'V' }),
    scopes: {},
  },
};

/** Canonical form: known modules only, each action once, in ACTIONS order, empty modules dropped. */
export function normalize(p: Partial<Record<string, readonly string[]>>): Permissions {
  const out: Permissions = {};
  for (const m of MODULES) {
    const acts = ACTIONS.filter((a) => p[m]?.includes(a));
    if (acts.length) out[m] = acts;
  }
  return out;
}

export function effective(role: Permissions, grants: Permissions = {}, denies: Permissions = {}): Permissions {
  const out: Partial<Record<Module, Action[]>> = {};
  for (const m of MODULES) {
    const acts = ACTIONS.filter((a) => (role[m]?.includes(a) || grants[m]?.includes(a)) && !denies[m]?.includes(a));
    if (acts.length) out[m] = acts;
  }
  return out;
}

export function can(p: Permissions, m: Module, a: Action): boolean {
  return p[m]?.includes(a) ?? false;
}

/** Escalation guard (PLAN §7): nobody hands out what they do not hold; the Owner is exempt. */
export function assertCanGrant(granter: Permissions, granterIsOwner: boolean, requested: Permissions): void {
  if (granterIsOwner) return;
  for (const m of MODULES) {
    const extra = (requested[m] ?? []).filter((a) => !can(granter, m, a));
    if (extra.length) {
      throw AppError.forbidden(`You can't give ${extra.join(', ')} on ${m} — you don't have it yourself.`);
    }
  }
}

export function assertCanGrantScopes(granterScopes: Scopes, granterIsOwner: boolean, requested: Scopes): void {
  if (granterIsOwner) return;
  for (const m of MODULES) {
    if ((requested[m] ?? 'shop') === 'shop' && granterScopes[m] === 'own') {
      throw AppError.forbidden(`You can't give shop-wide ${m} access — you only see your own.`);
    }
  }
}
