// B1 tenancy + RBAC checks (SECURITY.md §6): onboarding, invites, tenant isolation, escalation guard, owner protection.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

const shopBody = (over: Record<string, unknown> = {}) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: {
    name: 'Shri Ram Medical Store',
    address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' },
    phone: '033 2229 4410',
    drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418',
    drugLicenseExpiry: '2031-03',
    gstin: '19AAKFS4417M1Z6',
    pricingMode: 'MRP_INCLUSIVE',
    ...over,
  },
  termsVersion: '2026-10',
  agree: true,
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;

interface Me { shops: { shopId: string; isOwner: boolean; roleName: string }[]; invitations: number }
interface Ctx { permissions: Record<string, string[]>; scopes: Record<string, string>; isOwner: boolean; role: { key: string | null } }
interface Staff { seats: { used: number; max: number }; members: { id: string; email: string; status: string; isOwner: boolean }[] }
interface Role { id: string; key: string | null; isSystem: boolean; members: number; version: number; name: string }

async function main() {
  const h = await startHarness();
  const { RoleModel } = await import('../src/modules/roles/role.model.js');
  const { MembershipModel } = await import('../src/modules/memberships/membership.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { ShopModel } = await import('../src/modules/shops/shop.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { TermsAcceptanceModel } = await import('../src/modules/shops/terms-acceptance.model.js');
  const { inviteEmail } = await import('../src/services/email-templates.js');

  const owner = await h.signIn('rohit@shop1.test');

  section('1. Onboarding');
  const meta = data<{ terms: { version: string; points: unknown[] }; states: string[] }>(await owner.get('/shops/onboarding'));
  check('terms version and points come from the API', meta.terms.version === '2026-10' && meta.terms.points.length === 7);
  check('states list for the address', meta.states.includes('West Bengal'));
  check('no agree → 422', (await owner.post('/shops', { ...shopBody(), agree: false })).status === 422);
  check('old Terms version → 409', (await owner.post('/shops', { ...shopBody(), termsVersion: '2025-03' })).status === 409);
  const wrongState = await owner.post('/shops', shopBody({ gstin: '27AAKFS4417M1Z6' }));
  check('GSTIN from another state → 422', wrongState.status === 422, code(wrongState));
  check('expired licence → 422', (await owner.post('/shops', shopBody({ drugLicenseExpiry: '2020-01' }))).status === 422);
  check('bad phone → 422', (await owner.post('/shops', shopBody({ phone: '12345' }))).status === 422);
  check('unknown field → 422', (await owner.post('/shops', shopBody({ status: 'active' }))).status === 422);
  check('nothing half-created by the rejected attempts', (await ShopModel.countDocuments({})) === 0);
  const made = await owner.post('/shops', shopBody());
  check('shop created → 201', made.status === 201, code(made));
  const shop1 = data<{ id: string }>(made).id;
  const me1 = data<Me>(await owner.get('/auth/me'));
  check('me lists the shop, as owner', me1.shops.length === 1 && me1.shops[0]?.isOwner === true);
  check('5 system roles seeded', (await RoleModel.countDocuments({ shopId: shop1, isSystem: true })) === 5);
  check('14-day trial for 3 users', (await SubscriptionModel.countDocuments({ shopId: shop1, status: 'trial', maxUsers: 3 })) === 1);
  check('Terms acceptance recorded', (await TermsAcceptanceModel.countDocuments({ shopId: shop1, version: '2026-10' })) === 1);
  check('audit entry written', (await AuditLogModel.countDocuments({ shopId: shop1 })) >= 1);

  section('2. Tenant middleware');
  check('no X-Shop-Id → 400', (await owner.get('/shop/context')).status === 400);
  owner.shopId = '0123456789abcdef01234567';
  const unknownShop = await owner.get('/shop/context');
  owner.shopId = shop1;
  const ctx = data<Ctx>(await owner.get('/shop/context'));
  check('owner context has every module', ctx.isOwner && ctx.permissions.subscription?.includes('edit') === true);
  const other = await h.signIn('sourav@shop2.test');
  other.shopId = shop1;
  const notMine = await other.get('/shop/context');
  check('someone else’s shop → 403', notMine.status === 403, code(notMine));
  check('unknown and foreign shop give the same answer', unknownShop.status === notMine.status && unknownShop.json.error?.message === notMine.json.error?.message);

  section('3. Invite → accept');
  const roles = data<Role[]>(await owner.get('/roles'));
  const roleId = (key: string) => roles.find((r) => r.key === key)?.id ?? '';
  const inv = await owner.post('/staff', { email: 'sunita@shop1.test', name: 'Sunita Roy', roleId: roleId('cashier'), designation: 'Pharmacist' });
  check('invite cashier → 201', inv.status === 201, code(inv));
  check('invite carries a message', Boolean(inv.json.message));
  check('cannot invite as owner', (await owner.post('/staff', { email: 'x@shop1.test', name: 'X', roleId: roleId('owner') })).status === 403);
  check('same person twice → 409', (await owner.post('/staff', { email: 'sunita@shop1.test', name: 'Sunita', roleId: roleId('cashier') })).status === 409);
  const cashier = await h.signIn('sunita@shop1.test');
  const meC = data<Me>(await cashier.get('/auth/me'));
  check('invited user has no shop yet, one invitation', meC.shops.length === 0 && meC.invitations === 1);
  cashier.shopId = shop1;
  check('no shop data before accepting', (await cashier.get('/shop/context')).status === 403);
  const invites = data<{ id: string; shopName: string; roleName: string; invitedBy: string }[]>(await cashier.get('/invitations'));
  check('invitation shows shop, role, inviter', invites[0]?.shopName === 'Shri Ram Medical Store' && invites[0].roleName === 'Pharmacist' && invites[0].invitedBy === 'Rohit Agarwal');
  check('invitation shows nothing else', Object.keys(invites[0] ?? {}).sort().join() === 'id,invitedAt,invitedBy,roleName,shopName');
  check('cannot accept someone else’s invitation', (await other.post(`/invitations/${invites[0]?.id ?? ''}/accept`, { name: 'Sourav' })).status === 404);
  const acc = await cashier.post(`/invitations/${invites[0]?.id ?? ''}/accept`, { name: 'Sunita Roy', phone: '9748012290' });
  check('accept → 200', acc.status === 200, code(acc));
  const ctxC = data<Ctx>(await cashier.get('/shop/context'));
  check('cashier gets the cashier matrix', ctxC.role.key === 'cashier' && ctxC.permissions.pos?.join() === 'view,create' && !ctxC.permissions.staff);
  check('cashier sees only own sales', ctxC.scopes.sales === 'own');

  section('4. Permissions');
  check('cashier → staff list 403', (await cashier.get('/staff')).status === 403);
  check('cashier → roles 403', (await cashier.get('/roles')).status === 403);
  check('cashier → shop profile 403', (await cashier.get('/shop')).status === 403);
  check('cashier → invite 403', (await cashier.post('/staff', { email: 'y@shop1.test', name: 'Y', roleId: roleId('cashier') })).status === 403);

  section('5. Seats');
  await owner.post('/staff', { email: 'priya@shop1.test', name: 'Priya Das', roleId: roleId('manager') });
  const full = await owner.post('/staff', { email: 'amit@shop1.test', name: 'Amit Ghosh', roleId: roleId('cashier') });
  check('4th user on a 3-user trial → 409', full.status === 409, code(full));
  const staff = data<Staff>(await owner.get('/staff'));
  check('seat count 3 of 3', staff.seats.used === 3 && staff.seats.max === 3);

  const assignable = data<{ key: string | null; assignable: boolean }[]>(await owner.get('/staff/roles'));
  check('assignable roles never include owner', assignable.length === 4 && assignable.every((r) => r.key !== 'owner' && r.assignable));

  section('6. Manager limits (escalation guard)');
  const manager = await h.signIn('priya@shop1.test');
  const pid = data<{ id: string }[]>(await manager.get('/invitations'))[0]?.id ?? '';
  await manager.post(`/invitations/${pid}/accept`, { name: 'Priya Das' });
  manager.shopId = shop1;
  const ownerRow = staff.members.find((m) => m.isOwner);
  const cashierRow = staff.members.find((m) => m.email === 'sunita@shop1.test');
  const managerRow = staff.members.find((m) => m.email === 'priya@shop1.test');
  check('manager has no roles:create by default (PLAN §7 matrix)', (await manager.post('/roles', { name: 'Nope', permissions: { pos: ['view'] } })).status === 403);
  const mv = data<{ version: number }>(await owner.get(`/staff/${managerRow?.id ?? ''}`)).version;
  check('owner grants the manager roles:create', (await owner.put(`/staff/${managerRow?.id ?? ''}`, { roleId: roleId('manager'), grants: { roles: ['create'] }, version: mv })).status === 200);
  const tooMuch = await manager.post('/roles', { name: 'Billing boss', permissions: { pos: ['view', 'create'], subscription: ['view', 'edit'] } });
  check('manager cannot create a role above themselves → 403', tooMuch.status === 403, code(tooMuch));
  const fine = await manager.post('/roles', { name: 'Counter Lead', permissions: { pos: ['view', 'create'], sales: ['view', 'export'] } });
  check('manager can create an equal-or-lower role', fine.status === 201, code(fine));
  const mAssign = data<{ key: string | null; assignable: boolean }[]>(await manager.get('/staff/roles'));
  check('manager may assign every system role (all within their access)', mAssign.filter((r) => r.key !== null).every((r) => r.assignable));
  await owner.post('/roles', { name: 'Billing admin', permissions: { subscription: ['view', 'edit'] } });
  const withAdmin = data<{ name: string; assignable: boolean; id: string }[]>(await manager.get('/staff/roles'));
  const billingAdmin = withAdmin.find((r) => r.name === 'Billing admin');
  check('a role above the manager shows as not assignable', billingAdmin?.assignable === false);
  check('and the API refuses to assign it', (await manager.put(`/staff/${cashierRow?.id ?? ''}`, { roleId: billingAdmin?.id ?? '', version: data<{ version: number }>(await manager.get(`/staff/${cashierRow?.id ?? ''}`)).version })).status === 403);
  check('manager cannot touch the owner', (await manager.post(`/staff/${ownerRow?.id ?? ''}/suspend`)).status === 403);
  const mDetail = data<{ version: number }>(await manager.get(`/staff/${managerRow?.id ?? ''}`));
  check('manager cannot change own access', (await manager.put(`/staff/${managerRow?.id ?? ''}`, { roleId: roleId('manager'), grants: { subscription: ['edit'] }, version: mDetail.version })).status === 403);
  const cDetail = data<{ version: number }>(await manager.get(`/staff/${cashierRow?.id ?? ''}`));
  const grantDelete = await manager.put(`/staff/${cashierRow?.id ?? ''}`, { roleId: roleId('cashier'), grants: { staff: ['delete'] }, version: cDetail.version });
  check('manager cannot grant what they lack → 403', grantDelete.status === 403, code(grantDelete));
  check('manager cannot delete staff (no staff:delete)', (await manager.post(`/staff/${cashierRow?.id ?? ''}/remove`)).status === 403);

  section('7. Suspend cuts access at once');
  const susp = await manager.post(`/staff/${cashierRow?.id ?? ''}/suspend`);
  check('manager suspends cashier', susp.status === 200, code(susp));
  check('suspended cashier: signed out on the very next call', (await cashier.get('/shop/context')).status === 401);
  check('suspended cashier: refresh refused', (await cashier.post('/auth/refresh')).status === 401);
  check('suspended cashier: even /auth/me is refused at once', (await cashier.get('/auth/me')).status === 401);
  await owner.post(`/staff/${cashierRow?.id ?? ''}/reactivate`);
  const back = await h.signIn('sunita@shop1.test');
  back.shopId = shop1;
  check('reactivated cashier can work again', (await back.get('/shop/context')).status === 200);
  const stale = await owner.put(`/staff/${cashierRow?.id ?? ''}`, { roleId: roleId('cashier'), version: 0 });
  check('stale version → 409', stale.status === 409, code(stale));

  section('8. Remove, decline, re-invite');
  check('owner removes cashier', (await owner.post(`/staff/${cashierRow?.id ?? ''}/remove`)).status === 200);
  check('removed cashier is signed out at once', (await back.get('/shop/context')).status === 401);
  check('membership kept as removed (history)', (await MembershipModel.countDocuments({ shopId: shop1, status: 'removed' })) === 1);
  const amit = await owner.post('/staff', { email: 'amit@shop1.test', name: 'Amit Ghosh', roleId: roleId('cashier') });
  check('freed seat can be used', amit.status === 201, code(amit));
  const amitC = await h.signIn('amit@shop1.test');
  const aid = data<{ id: string }[]>(await amitC.get('/invitations'))[0]?.id ?? '';
  check('decline → 200', (await amitC.post(`/invitations/${aid}/decline`)).status === 200);
  check('declined user still has no shop', data<Me>(await amitC.get('/auth/me')).shops.length === 0);
  check('owner re-invites the declined user', (await owner.post(`/staff/${amit.json.data ? data<{ id: string }>(amit).id : ''}/reinvite`)).status === 200);
  check('seats full again after the re-invite → 409', (await owner.post('/staff', { email: 'sunita@shop1.test', name: 'Sunita Roy', roleId: roleId('cashier') })).status === 409);
  check('owner removes the pending invite to free a seat', (await owner.post(`/staff/${data<{ id: string }>(amit).id}/remove`)).status === 200);
  const again = await owner.post('/staff', { email: 'sunita@shop1.test', name: 'Sunita Roy', roleId: roleId('cashier') });
  check('removed user can be invited again', again.status === 201, code(again));
  check('re-invite reuses the same membership (history kept)', again.json.data !== undefined && data<{ id: string }>(again).id === cashierRow?.id);

  section('9. Roles');
  const roles2 = data<Role[]>(await owner.get('/roles'));
  const sysRole = roles2.find((r) => r.key === 'manager');
  const custom = roles2.find((r) => r.name === 'Counter Lead');
  check('built-in role cannot be edited', (await owner.put(`/roles/${sysRole?.id ?? ''}`, { name: 'Boss', permissions: { pos: ['view'] }, version: sysRole?.version ?? 0 })).status === 403);
  check('built-in role cannot be deleted', (await owner.del(`/roles/${sysRole?.id ?? ''}`)).status === 403);
  check('duplicate role name → 409', (await owner.post('/roles', { name: 'counter lead', permissions: { pos: ['view'] } })).status === 409);
  const edit = await owner.put(`/roles/${custom?.id ?? ''}`, { name: 'Counter Lead', permissions: { pos: ['view', 'create'] }, version: custom?.version ?? 0 });
  check('owner edits a custom role', edit.status === 200, code(edit));
  check('editing with the old version → 409', (await owner.put(`/roles/${custom?.id ?? ''}`, { name: 'Counter Lead', permissions: { pos: ['view'] }, version: custom?.version ?? 0 })).status === 409);
  check('empty permission set → 422', (await owner.post('/roles', { name: 'Nothing', permissions: {} })).status === 422);
  check('unknown module → 422', (await owner.post('/roles', { name: 'Odd', permissions: { rockets: ['view'] } })).status === 422);
  check('custom role without members can be deleted', (await owner.del(`/roles/${custom?.id ?? ''}`)).status === 200);

  section('10. Cross-shop ids (IDOR)');
  const s2 = await other.post('/shops', shopBody({ name: 'Life Care Pharmacy', gstin: '19AAHFL8821Q1Z2' }));
  const shop2 = data<{ id: string }>(s2).id;
  other.shopId = shop2;
  check('second owner works in own shop', (await other.get('/staff')).status === 200);
  check('shop1 staff id from shop2 → 404', (await other.get(`/staff/${managerRow?.id ?? ''}`)).status === 404);
  check('shop1 staff action from shop2 → 404', (await other.post(`/staff/${managerRow?.id ?? ''}/suspend`)).status === 404);
  check('shop1 role id from shop2 → 404', (await other.get(`/roles/${sysRole?.id ?? ''}`)).status === 404);
  const shop1Roles = data<Role[]>(await owner.get('/roles'));
  const assignForeign = await other.post('/staff', { email: 'z@shop2.test', name: 'Z', roleId: shop1Roles.find((r) => r.key === 'cashier')?.id ?? '' });
  check('assigning shop1 role inside shop2 → 404', assignForeign.status === 404, code(assignForeign));
  check('shop2 staff list has only its own people', data<Staff>(await other.get('/staff')).members.every((m) => m.email.endsWith('@shop2.test')));

  section('11. Shop state');
  const { istMonth } = await import('../src/utils/date.js');
  const profile = data<{ version: number; name: string; drugLicenseExpiry: string }>(await owner.get('/shop'));
  check('licence expiry is month-end IST of the month typed', istMonth(new Date(profile.drugLicenseExpiry)) === '2031-03' && istMonth(new Date(new Date(profile.drugLicenseExpiry).getTime() + 1000)) === '2031-04');
  const upd = await owner.patch('/shop', { ...shopBody().shop, pricingMode: undefined, legalName: 'Shri Ram Medical Store LLP', version: profile.version });
  check('owner updates the profile', upd.status === 200, code(upd));
  check('saving the same month keeps it (no drift)', istMonth(new Date(data<{ drugLicenseExpiry: string }>(upd).drugLicenseExpiry)) === '2031-03');
  check('stale profile version → 409', (await owner.patch('/shop', { ...shopBody().shop, pricingMode: undefined, legalName: 'X', version: profile.version })).status === 409);
  // D64: the date decides — a plan 8 days past its end (beyond grace) is expired.
  const subBefore = await SubscriptionModel.findOne({ shopId: shop1 }).lean();
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { endDate: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });
  const ro = await owner.post('/staff', { email: 'q@shop1.test', name: 'Q', roleId: roleId('cashier') });
  check('expired plan: writes → 402', ro.status === 402, code(ro));
  check('expired plan: reads still work', (await owner.get('/staff')).status === 200);
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { status: 'trial', endDate: subBefore?.endDate } });
  await ShopModel.updateOne({ _id: shop1 }, { $set: { status: 'suspended' } });
  check('suspended shop → 403', (await owner.get('/staff')).status === 403);
  await ShopModel.updateOne({ _id: shop1 }, { $set: { status: 'active' } });

  section('11b. A signed-out session, whatever shop it names');
  const later = await h.signIn('rohit@shop1.test');
  const cookie = `ms_at=${later.jar.get('ms_at') ?? ''}`;
  const bare = h.client();
  const asShop = async (shop: string) => (await bare.raw('GET', '/staff', undefined, { cookie, 'x-shop-id': shop })).status;
  const before = [await asShop(shop1), await asShop(shop2), await asShop('nope')];
  check('while signed in: own shop 200, another shop 403, no shop 400', before.join() === '200,403,400', before.join());
  check('sign out', (await later.post('/auth/logout')).status === 200);
  const after = [await asShop(shop1), await asShop(shop2), await asShop('nope')];
  check('the same cookie after sign-out → 401 for own shop, another shop and no shop', after.join() === '401,401,401', after.join());

  section('12. Guards in the code itself');
  let threw = false;
  try {
    await RoleModel.find({}).lean();
  } catch {
    threw = true;
  }
  check('a tenant query without shopId throws', threw);
  const mail = inviteEmail({ shopName: '<script>alert(1)</script>', roleName: 'Cashier', inviterName: 'A&B', appUrl: 'http://localhost:3000' });
  check('invite email escapes shop and inviter names', !mail.html.includes('<script>') && mail.html.includes('A&#38;B'));
  check('staff actions are audited', (await AuditLogModel.countDocuments({ shopId: shop1, module: 'staff' })) >= 6);

  await h.close();
  finish();
}

main().catch(crash);

