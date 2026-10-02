// B9a checks: email code + TOTP, admin and shop sessions never mix, roles, every action needs a reason and is audited twice.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const DAY = 86_400_000;

async function main() {
  const h = await startHarness();
  const { AdminUserModel, AdminAuditModel, AdminSessionModel } = await import('../src/modules/admin/admin.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { SubscriptionPaymentModel } = await import('../src/modules/subscription/billing.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const step = () => Math.floor(Date.now() / 30_000);

  // One shop to look after.
  const owner = await h.signIn('rohit@adm1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;

  await AdminUserModel.create({ email: 'root@medshop.test', name: 'Root', role: 'super' });
  /** Email code → TOTP; returns the signed-in admin client and its secret. */
  const login = async (email: string, secret?: string, offset = 0) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const v = await c.post('/admin/auth/verify', { email, otp: '135790' });
    const r = data<{ stage: string; secret?: string }>(v);
    const s = secret ?? r.secret ?? '';
    const t = await c.post('/admin/auth/totp', { code: totpAt(s, step() + offset) });
    return { c, secret: s, first: r, verify: v, totp: t };
  };

  section('1. Signing in: email code, then authenticator');
  const anon = h.client({ origin: 'http://localhost:3001' });
  const askNon = await anon.post('/admin/auth/code', { email: 'stranger@x.test' });
  const askRoot = await anon.post('/admin/auth/code', { email: 'root@medshop.test' });
  check('a stranger and an admin get the same answer', askNon.status === 200 && askRoot.status === 200 && askNon.json.message === askRoot.json.message);
  check('wrong email code → 401', (await anon.post('/admin/auth/verify', { email: 'root@medshop.test', otp: '000000' })).status === 401);
  const r1 = await login('root@medshop.test');
  check('first sign-in asks to set up the authenticator, then signs in', r1.first.stage === 'setup' && (r1.first.secret?.length ?? 0) >= 32 && r1.totp.status === 200, code(r1.totp));
  const root = r1.c;
  check('/admin/me → super', data<{ role: string }>(await root.get('/admin/me')).role === 'super');
  const stored = await AdminUserModel.findOne({ email: 'root@medshop.test' }).lean();
  check('the secret is stored sealed, never plain', Boolean(stored?.totpSecretEnc) && !stored?.totpSecretEnc?.includes(r1.secret));
  const pre = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('root@medshop.test', '135790', 'admin');
  const v2 = await pre.post('/admin/auth/verify', { email: 'root@medshop.test', otp: '135790' });
  check('next time: authenticator only (no new secret)', data<{ stage: string }>(v2).stage === 'totp');
  check('after the email code alone, the console is shut → 401', (await pre.get('/admin/overview')).status === 401);
  check('the code just used can’t sign in again (replay) → 401', (await pre.post('/admin/auth/totp', { code: totpAt(r1.secret, step()) })).status === 401);
  for (let i = 0; i < 5; i++) await pre.post('/admin/auth/totp', { code: '000000' });
  check('5 wrong authenticator codes → start again', (await pre.post('/admin/auth/totp', { code: totpAt(r1.secret, step() + 1) })).status === 401);

  section('2. Admin and shop sessions never mix');
  check('a shop owner’s cookie on /admin → 401', (await owner.get('/admin/overview')).status === 401);
  const shopTry = await root.get('/auth/me');
  check('the admin’s cookie on shop routes → 401', shopTry.status === 401, code(shopTry));

  section('3. Shops, without their private data');
  const list = data<{ id: string; name: string; plan: { status: string } }[]>(await root.get('/admin/shops'));
  check('the shop is listed with its plan', list.some((s) => s.id === shopId && s.plan.status === 'trial'));
  const detail = data<Record<string, unknown>>(await root.get(`/admin/shops/${shopId}`));
  check('detail has owner, plan, users, payments — no bills, stock or customers', ['owner', 'plan', 'users', 'payments'].every((k) => k in detail) && !['sales', 'products', 'customers', 'stock'].some((k) => k in detail));

  section('4. Every action needs a reason and is audited twice');
  const before = (await SubscriptionModel.findOne({ shopId }).lean())?.endDate.getTime() ?? 0;
  check('add days with no reason → 422', (await root.post(`/admin/shops/${shopId}/extend`, { days: 10 })).status === 422);
  const ext = await root.post(`/admin/shops/${shopId}/extend`, { days: 10, reason: 'Goodwill after a support call' });
  const after = (await SubscriptionModel.findOne({ shopId }).lean())?.endDate.getTime() ?? 0;
  check('10 days added to the trial', ext.status === 200 && after - before === 10 * DAY, code(ext));
  check('admin audit has who, what, why', Boolean(await AdminAuditModel.exists({ action: 'plan_extend', reason: 'Goodwill after a support call', adminName: 'Root', shopId })));
  check('the shop’s own audit log shows MedShop did it (D15)', Boolean(await AuditLogModel.exists({ shopId, text: { $regex: '^MedShop \\(Root\\) added 10 days' } })));
  const sus = await root.post(`/admin/shops/${shopId}/status`, { status: 'suspended', reason: 'Licence under review' });
  check('suspend → the shop can’t open (403)', sus.status === 200 && (await owner.get('/staff')).status === 403);
  await root.post(`/admin/shops/${shopId}/status`, { status: 'active', reason: 'Licence verified' });
  check('turn back on → opens again', (await owner.get('/staff')).status === 200);

  section('5. Roles');
  await root.post('/admin/team', { email: 'sara@medshop.test', name: 'Sara', role: 'support', reason: 'New support hire' });
  await root.post('/admin/team', { email: 'amit@medshop.test', name: 'Amit', role: 'accounts', reason: 'Accounts desk' });
  await root.post('/admin/team', { email: 'vee@medshop.test', name: 'Vee', role: 'viewer', reason: 'Investor read access' });
  const sara = (await login('sara@medshop.test')).c;
  const amit = (await login('amit@medshop.test')).c;
  const vee = (await login('vee@medshop.test')).c;
  check('viewer reads shops but can’t add days → 403', (await vee.get('/admin/shops')).status === 200 && (await vee.post(`/admin/shops/${shopId}/extend`, { days: 1, reason: 'trying it out' })).status === 403);
  check('support adds days, can’t see payments or record money → 403', (await sara.post(`/admin/shops/${shopId}/extend`, { days: 1, reason: 'support fix' })).status === 200 && (await sara.get('/admin/payments')).status === 403 && (await sara.post('/admin/payments/manual', { shopId, planCode: 'monthly', reference: 'UTR123', reason: 'bank transfer' })).status === 403);
  check('only super changes plans, settings and the team', (await amit.put('/admin/plans', { plans: [], reason: 'x'.repeat(6) })).status === 403 && (await sara.get('/admin/team')).status === 403);

  section('6. Money taken by hand (accounts)');
  const man = await amit.post('/admin/payments/manual', { shopId, planCode: 'monthly', reference: 'UTR998877', reason: 'Bank transfer received' });
  const pay = await SubscriptionPaymentModel.findOne({ shopId, source: 'manual' }).lean();
  const sub = await SubscriptionModel.findOne({ shopId }).lean();
  check('recorded: paid, invoice issued, shop on Monthly', man.status === 200 && pay?.status === 'paid' && /^MS-/.test(pay.invoiceNumber ?? '') && sub?.planCode === 'monthly', code(man));
  check('accounts sees all payments', data<unknown[]>(await amit.get('/admin/payments')).length >= 1);

  section('7. Plans and platform settings (super)');
  const pl = await root.put('/admin/plans', { plans: [{ code: 'monthly', name: 'Monthly', price: 99_900, durationDays: 30, maxUsers: 5, isActive: true }, { code: 'yearly', name: 'Yearly', price: 999_000, durationDays: 365, maxUsers: 10, isActive: true }], reason: 'New price list for 2027' });
  check('new price shows on the public plan list', pl.status === 200 && data<{ price: number }[]>(await h.client().get('/plans'))[0]?.price === 99_900, code(pl));
  const st = await root.put('/admin/settings', { settings: { trialDays: 21, trialMaxUsers: 4, graceDays: 3, supportEmail: 'help@medshop.test', supportPhone: '1800 000 000', maintenance: { on: false, message: '' } }, reason: 'Longer trial for the launch' });
  check('settings saved', st.status === 200, code(st));
  await root.put('/admin/settings', { settings: { trialDays: 21, trialMaxUsers: 4, graceDays: 3, supportEmail: 'help@medshop.test', supportPhone: '1800 000 000', maintenance: { on: true, message: 'Upgrade tonight 11 pm' } }, reason: 'Planned upgrade window' });
  const pub = data<{ maintenance: { on: boolean; message: string }; supportEmail: string }>(await h.client().get('/platform'));
  check('the shop app sees the maintenance notice and support email (public)', pub.maintenance.on && pub.maintenance.message === 'Upgrade tonight 11 pm' && pub.supportEmail === 'help@medshop.test');
  const o2 = await h.signIn('kakoli@adm2.test');
  const s2 = data<{ id: string }>(await o2.post('/shops', shopBody('Kakoli Pharmacy'))).id;
  const sub2 = await SubscriptionModel.findOne({ shopId: s2 }).lean();
  check('a new shop now gets a 21-day trial for 4 users', Boolean(sub2) && Math.round(((sub2?.endDate.getTime() ?? 0) - Date.now()) / DAY) === 21 && sub2?.maxUsers === 4);
  o2.shopId = s2;
  await SubscriptionModel.updateOne({ shopId: s2 }, { $set: { endDate: new Date(Date.now() - 4 * DAY) } });
  check('grace is 3 days now: 4 days past the end → read-only (402)', (await o2.post('/expenses', { clientRequestId: crypto.randomUUID(), date: new Date().toISOString().slice(0, 10), category: 'Rent', description: '', amount: 100, paymentMode: 'UPI', fromDrawer: false, vendor: '', referenceNumber: '' })).status === 402);

  section('8. Team and sessions');
  const team = data<{ id: string; email: string }[]>(await root.get('/admin/team'));
  const saraId = team.find((u) => u.email === 'sara@medshop.test')?.id ?? '';
  check('can’t change yourself → 409', (await root.patch(`/admin/team/${team.find((u) => u.email === 'root@medshop.test')?.id ?? ''}`, { status: 'disabled', reason: 'testing myself' })).status === 409);
  await root.patch(`/admin/team/${saraId}`, { status: 'disabled', reason: 'Left the company' });
  check('a turned-off member’s open session stops at once → 401', (await sara.get('/admin/shops')).status === 401);
  await AdminSessionModel.updateMany({ adminUserId: (await AdminUserModel.findOne({ email: 'amit@medshop.test' }).lean())?._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  check('an 8-hour session past its end → 401', (await amit.get('/admin/overview')).status === 401);
  await root.post('/admin/auth/logout');
  check('sign out → 401', (await root.get('/admin/overview')).status === 401);
  check('every admin action is in the admin log (8+)', (await AdminAuditModel.countDocuments({})) >= 8);

  await h.close();
  finish();
}

main().catch(crash);
