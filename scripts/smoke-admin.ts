// B9a checks: email code + TOTP, admin and shop sessions never mix, roles, every action needs a reason and is audited twice.
import { check, crash, finish, section, startHarness, type Res, unzip } from './lib/harness';

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
  const ov = data<{ trend: { day: string; paid: number; signups: number }[]; recent: { shopName: string; amount: number; invoiceNumber: string | null }[]; ending: unknown[] }>(await amit.get('/admin/overview'));
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  check('overview: 30 IST days, today holds the payment and the new shop', ov.trend.length === 30 && ov.trend.at(-1)?.day === today && (ov.trend.at(-1)?.paid ?? 0) >= (pay?.amount ?? 1) && (ov.trend.at(-1)?.signups ?? 0) >= 1, JSON.stringify(ov.trend.at(-1)));
  check('overview: recent payments name the shop and the invoice', ov.recent[0]?.shopName === 'Shri Ram Medical Store' && ov.recent[0].invoiceNumber === pay?.invoiceNumber && Array.isArray(ov.ending));

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

  section('8. Support access: the owner decides, read-only, for the hours given (A16)');
  const { SupportAccessModel } = await import('../src/modules/admin/support.js');
  const range = `from=${new Date(Date.now() + 19_800_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 19_800_000).toISOString().slice(0, 10)}`;
  const req1 = await root.post(`/admin/shops/${shopId}/support`, { hours: 4, reason: 'Owner says a bill total looks wrong' });
  const acc = data<{ id: string; status: string }>(req1);
  check('support asks for 4 hours → pending', req1.status === 200 && acc.status === 'pending', code(req1));
  check('a second open request → 409', (await root.post(`/admin/shops/${shopId}/support`, { hours: 1, reason: 'one more time' })).status === 409);
  const mine = data<{ id: string; status: string }[]>(await owner.get('/support-access'));
  const bell = data<{ items: { type: string }[] }>(await owner.get('/notifications'));
  check('the owner sees it in the app and on the bell', mine[0]?.id === acc.id && bell.items.some((i) => i.type === 'SUPPORT_ACCESS'));
  check('before the owner says yes → 403', (await root.get(`/admin/support/${acc.id}/r/sales-register?${range}`)).status === 403);
  const ok = await owner.post(`/support-access/${acc.id}/approve`, {});
  check('owner approves → running for 4 hours', ok.status === 200 && data<{ status: string }>(ok).status === 'approved');
  const view = await root.get(`/admin/support/${acc.id}/r/sales-register?${range}`);
  check('support reads the sales register', view.status === 200 && Array.isArray(data<{ rows: unknown[] }>(view).rows), code(view));
  check('the shop’s audit shows “MedShop Support (Root) viewed Sales register”', Boolean(await AuditLogModel.exists({ shopId, text: 'MedShop Support (Root) viewed Sales register' })));
  const zr = await root.get(`/admin/support/${acc.id}/files.zip`);
  const zipNames = zr.status === 200 ? [...unzip(zr.body).keys()] : [];
  check('support downloads the shop’s photos as a ZIP, one folder <name>_<id>/', zr.status === 200 && zr.headers.get('content-type') === 'application/zip' && zipNames.length > 0 && zipNames.every((n) => n.split('/')[0]?.endsWith('_' + shopId)) && zipNames.some((n) => n.endsWith('/index.csv')), code(zr) + ' ' + zipNames.join(' | '));
  check('the ZIP is on the shop’s audit and the admin audit', Boolean(await AuditLogModel.exists({ shopId, entityName: 'Photos ZIP', text: /^MedShop Support \(Root\) downloaded/ })) && Boolean(await AdminAuditModel.exists({ shopId, action: 'support_files' })));
  check('ZIP: accounts / viewer → 403, another admin → 404', (await amit.get(`/admin/support/${acc.id}/files.zip`)).status === 403 && (await vee.get(`/admin/support/${acc.id}/files.zip`)).status === 403 && (await sara.get(`/admin/support/${acc.id}/files.zip`)).status === 404);
  check('accounts and viewer can’t use it → 403; another admin’s access → 404', (await amit.get(`/admin/support/${acc.id}/r/sales-register?${range}`)).status === 403 && (await vee.get(`/admin/support/${acc.id}/r/sales-register?${range}`)).status === 403 && (await sara.get(`/admin/support/${acc.id}/r/sales-register?${range}`)).status === 404);
  check('the owner stops it → 403 at once', (await owner.post(`/support-access/${acc.id}/revoke`, {})).status === 200 && (await root.get(`/admin/support/${acc.id}/r/sales-register?${range}`)).status === 403 && (await root.get(`/admin/support/${acc.id}/files.zip`)).status === 403);
  const acc2 = data<{ id: string }>(await root.post(`/admin/shops/${shopId}/support`, { hours: 1, reason: 'Second look at stock' }));
  await owner.post(`/support-access/${acc2.id}/approve`, {});
  await SupportAccessModel.updateOne({ shopId, _id: acc2.id }, { $set: { endsAt: new Date(Date.now() - 1000) } });
  check('time up → 403 and it reads “ended”', (await root.get(`/admin/support/${acc2.id}/r/stock-on-hand`)).status === 403 && data<{ id: string; status: string }[]>(await root.get('/admin/support')).find((x) => x.id === acc2.id)?.status === 'ended');
  check('a decided request can’t be decided again → 409', (await owner.post(`/support-access/${acc2.id}/deny`, {})).status === 409);
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'vikram@adm1.test', name: 'vikram', roleId: roles.find((r) => r.key === 'manager')?.id });
  const mgr = await h.signIn('vikram@adm1.test');
  await mgr.post(`/invitations/${data<{ id: string }[]>(await mgr.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'vikram' });
  mgr.shopId = shopId;
  const acc3 = data<{ id: string }>(await root.post(`/admin/shops/${shopId}/support`, { hours: 1, reason: 'Third look' }));
  check('only the owner decides: a manager → 403', (await mgr.post(`/support-access/${acc3.id}/approve`, {})).status === 403);
  await owner.post(`/support-access/${acc3.id}/deny`, {});

  section('9. A shop’s own price (PLAN §36.1)');
  const planOf = async () => data<{ plans: { code: string; price: number; listPrice: number; upcoming: { price: number; from: string } | null }[] }>(await owner.get('/subscription')).plans.find((p) => p.code === 'monthly');
  const cut = await amit.put(`/admin/shops/${shopId}/prices`, { prices: [{ code: 'monthly', price: 59_900 }], reason: 'Launch discount for an early shop' });
  const m1 = await planOf();
  check('a cut applies now: ₹599 (list ₹999)', cut.status === 200 && m1?.price === 59_900 && m1.listPrice === 99_900 && m1.upcoming === null, code(cut));
  check('support can’t set prices → 403', (await sara.put(`/admin/shops/${shopId}/prices`, { prices: [{ code: 'monthly', price: 1000 }], reason: 'trying it out' })).status === 403);
  await amit.put(`/admin/shops/${shopId}/prices`, { prices: [{ code: 'monthly', price: 129_900 }], reason: 'Discount period over' });
  const m2 = await planOf();
  check('a rise waits 30 days: still ₹599, ₹1,299 from then', m2?.price === 59_900 && m2.upcoming?.price === 129_900 && Math.round((new Date(m2.upcoming.from).getTime() - Date.now()) / DAY) === 30, JSON.stringify(m2));
  check('an order now is at ₹599', data<{ amount: number }>(await owner.post('/subscription/order', { planCode: 'monthly' })).amount === 59_900);
  const { ShopTermsModel } = await import('../src/modules/subscription/terms.js');
  const from1 = (await ShopTermsModel.findOne({ shopId }).lean())?.priceFrom?.getTime();
  await amit.put(`/admin/shops/${shopId}/prices`, { prices: [{ code: 'yearly', price: 899_000 }], reason: 'Yearly cut too' });
  check('another edit doesn’t restart the 30 days', (await ShopTermsModel.findOne({ shopId }).lean())?.priceFrom?.getTime() === from1);
  await ShopTermsModel.updateOne({ shopId }, { $set: { priceFrom: new Date(Date.now() - 1000) } });
  check('after the notice: ₹1,299', (await planOf())?.price === 129_900);
  check('the admin log has old → new', Boolean(await AdminAuditModel.exists({ action: 'price_update', text: { $regex: 'monthly ₹599.00 → ₹1,299.00' } })));

  section('10. Health');
  const hl = await vee.get('/admin/health');
  check('health: mail queue, jobs, webhooks', hl.status === 200 && ['mail', 'jobs', 'webhooks'].every((k) => k in (hl.json.data as object)), code(hl));

  section('13. Monitoring: a limit crossed emails the super admins');
  const { SignalModel, signal } = await import('../src/services/monitor.js');
  const { checkAlerts } = await import('../src/modules/notifications/jobs.js');
  const { EmailJobModel } = await import('../src/services/mail-queue.js');
  const fails = async () => (await SignalModel.aggregate<{ n: number }>([{ $match: { kind: 'admin_login_fail' } }, { $group: { _id: null, n: { $sum: '$n' } } }]))[0]?.n ?? 0;
  const f0 = await fails();
  await h.seedOtp('vee@medshop.test', '135790', 'admin');
  await h.client({ origin: 'http://localhost:3001' }).post('/admin/auth/verify', { email: 'vee@medshop.test', otp: '000000' });
  check('a wrong admin email code is counted', (await fails()) === f0 + 1, `${String(f0)} → ${String(await fails())}`);
  // Three days ahead at hh:20, so nothing real falls in the 15-minute window.
  const T = new Date(Math.ceil((Date.now() + 3 * DAY) / 3_600_000) * 3_600_000 + 20 * 60_000);
  for (let i = 0; i < 4; i++) await signal('server_error', T);
  await signal('webhook_bad_signature', T);
  await EmailJobModel.deleteMany({ kind: 'monitor_alert' });
  const a1 = await checkAlerts(T);
  const alertMails = await EmailJobModel.find({ kind: 'monitor_alert' }).lean();
  check('1 bad webhook signature → alert; 4 server errors (limit 5) → not yet', a1.join() === 'webhook_bad_signature', a1.join());
  check('the alert goes to the active super admins only', alertMails.length === 1 && alertMails[0]?.to === 'root@medshop.test' && /bad signature/.test(alertMails.map((m) => m.subject).join()), alertMails.map((m) => m.to).join());
  await signal('server_error', T);
  const a2 = await checkAlerts(new Date(T.getTime() + 60_000));
  check('the 5th server error alerts; the webhook one isn’t sent again this hour', a2.join() === 'server_error', a2.join());
  const a3 = await checkAlerts(new Date(T.getTime() + 2 * 60_000));
  check('nothing new → no new email', a3.length === 0 && (await EmailJobModel.countDocuments({ kind: 'monitor_alert' })) === 2);
  check('an hour later the window is clear → quiet', (await checkAlerts(new Date(T.getTime() + 60 * 60_000))).length === 0);
  const sig = data<{ signals: { kind: string; last24h: number; limit: number }[] }>(await vee.get('/admin/health')).signals;
  check('health lists every signal with its limit and 24-hour count', sig.length === 6 && (sig.find((s) => s.kind === 'admin_login_fail')?.last24h ?? 0) >= 1, JSON.stringify(sig));

  section('12. Idle lock: PIN or authenticator to carry on (the session stays)');
  await AdminUserModel.create({ email: 'lock@medshop.test', name: 'Lena', role: 'support' });
  const lk = await login('lock@medshop.test');
  const lena = lk.c;
  const me0 = data<{ hasPin: boolean; idleMinutes: number }>(await lena.get('/admin/me'));
  check('signed in: no PIN yet, locks after 15 idle minutes', !me0.hasPin && me0.idleMinutes === 15);
  const lenaId = (await AdminUserModel.findOne({ email: 'lock@medshop.test' }).lean())?._id;
  await AdminSessionModel.updateMany({ adminUserId: lenaId, stage: 'full' }, { $set: { lastUsedAt: new Date(Date.now() - 16 * 60_000) } });
  const idle = await lena.get('/admin/shops');
  check('16 idle minutes → 423 LOCKED, asks for the authenticator (no PIN)', idle.status === 423 && /authenticator/.test(idle.json.error?.message ?? ''), code(idle));
  check('…and the session is not ended — still locked, not 401', (await lena.get('/admin/me')).status === 423);
  const badCode = await lena.post('/admin/auth/unlock', { code: '000000' });
  check('wrong authenticator code → 422 with tries left', badCode.status === 422 && /4 tries left/.test(badCode.json.error?.message ?? ''), code(badCode));
  const goodCode = totpAt(lk.secret, step() + 1);
  const un1 = await lena.post('/admin/auth/unlock', { code: goodCode });
  check('authenticator code → unlocked, pages open again', un1.status === 200 && (await lena.get('/admin/shops')).status === 200, code(un1));
  await lena.post('/admin/auth/lock');
  check('Lock now → 423 at once', (await lena.get('/admin/overview')).status === 423);
  check('the same authenticator code can’t unlock twice (replay)', (await lena.post('/admin/auth/unlock', { code: goodCode })).status === 422);
  check('a PIN when none is set → 422', (await lena.post('/admin/auth/unlock', { pin: '2468' })).status === 422);
  await AdminUserModel.updateOne({ _id: lenaId }, { $set: { totpLastStep: 0, pinFails: 0 } });
  await lena.post('/admin/auth/unlock', { code: totpAt(lk.secret, step()) });
  check('setting a PIN without an authenticator code → 400/422', [400, 422].includes((await lena.put('/admin/me/pin', { pin: '2468' })).status));
  check('setting a PIN with a wrong authenticator code → 422', (await lena.put('/admin/me/pin', { pin: '2468', code: '000000' })).status === 422);
  await AdminUserModel.updateOne({ _id: lenaId }, { $set: { totpLastStep: 0 } });
  const setPin = await lena.put('/admin/me/pin', { pin: '2468', code: totpAt(lk.secret, step()) });
  const stored2 = await AdminUserModel.findOne({ _id: lenaId }).lean();
  check('PIN saved with a fresh authenticator code, stored hashed, audited', setPin.status === 200 && data<{ hasPin: boolean }>(setPin).hasPin && Boolean(stored2?.pinHash) && !stored2?.pinHash?.includes('2468') && Boolean(await AdminAuditModel.exists({ adminUserId: lenaId, action: 'pin_set' })), code(setPin));
  await lena.post('/admin/auth/lock');
  const locked2 = await lena.get('/admin/shops');
  check('locked with a PIN set → the message asks for the PIN', locked2.status === 423 && /PIN/.test(locked2.json.error?.message ?? ''));
  check('wrong PIN → 422, 4 tries left', /4 tries left/.test((await lena.post('/admin/auth/unlock', { pin: '1111' })).json.error?.message ?? ''));
  const unPin = await lena.post('/admin/auth/unlock', { pin: '2468' });
  check('right PIN → unlocked; the wrong-try count resets', unPin.status === 200 && (await AdminUserModel.findOne({ _id: lenaId }).lean())?.pinFails === 0, code(unPin));
  await lena.post('/admin/auth/lock');
  for (let i = 0; i < 4; i++) await lena.post('/admin/auth/unlock', { pin: '1111' });
  const fifth = await lena.post('/admin/auth/unlock', { pin: '1111' });
  check('5 wrong PINs → the session ends (401), sign in again', fifth.status === 401 && (await lena.get('/admin/me')).status === 401, code(fifth));
  check('…the session is revoked in the database', (await AdminSessionModel.countDocuments({ adminUserId: lenaId, stage: 'full', revokedAt: null })) === 0);
  const other = await login('lock@medshop.test', lk.secret, 1);
  check('a new sign-in still works; the PIN survives for next time', other.totp.status === 200 && data<{ hasPin: boolean }>(await other.c.get('/admin/me')).hasPin, code(other.totp));
  const cleared = await other.c.del('/admin/me/pin');
  check('remove the PIN → hasPin false, audited', cleared.status === 200 && !data<{ hasPin: boolean }>(cleared).hasPin && Boolean(await AdminAuditModel.exists({ adminUserId: lenaId, action: 'pin_cleared' })));

  section('11. Team and sessions');
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
