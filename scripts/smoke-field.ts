// D100 checks: field staff — added by a super admin with email + code, sign in by password or email code (no
// authenticator, 7-day session), the code gives a new shop the staff trial, drafts the owner confirms, a code added later.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const DAY = 86_400_000;
const shop = (name: string) => ({ name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' });
const signup = (name: string, referralCode?: string) => ({ owner: { name: 'Rohit Agarwal', phone: '98300 41122' }, shop: shop(name), termsVersion: '2026-10', agree: true, ...(referralCode ? { referralCode } : {}) });
const days = (end: string | Date, start = Date.now()) => Math.round((new Date(end).getTime() - start) / DAY);
type Mine = { code: string; trialDays: number; totals: { joined: number; onTrial: number; paying: number }; shops: { shopName: string; source: string; status: string }[]; drafts: { shopName: string; status: string }[] };

async function main() {
  const h = await startHarness();
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { EmailJobModel } = await import('../src/services/mail-queue.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');
  const { FieldStaffModel } = await import('../src/modules/field/field.model.js');
  const step = () => Math.floor(Date.now() / 30_000);
  const ADMIN = { origin: 'http://localhost:3001' };
  await AdminUserModel.create([{ email: 'root@fld.test', name: 'Root', role: 'super' }, { email: 'help@fld.test', name: 'Help Desk', role: 'support' }]);
  const login = async (email: string) => {
    const c = h.client(ADMIN);
    await h.seedOtp(email, '135790', 'admin');
    const s = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' })).secret ?? '';
    await c.post('/admin/auth/totp', { code: totpAt(s, step()) });
    return c;
  };
  const root = await login('root@fld.test');
  const help = await login('help@fld.test');
  const subOf = async (id: string) => SubscriptionModel.findOne({ shopId: new Types.ObjectId(id) }).lean();

  section('1. A super admin adds field staff: email + code, nothing else');
  const ref = await h.signIn('referrer@fld.test');
  ref.shopId = data<{ id: string }>(await ref.post('/shops', signup('Referrer Pharmacy'))).id;
  const shopCode = data<{ code: string }>(await ref.get('/referral')).code;
  check('support can’t add staff → 403', (await help.post('/admin/field-staff', { email: 'rahul@fld.test', code: 'RAHUL90', reason: 'new field staff' })).status === 403);
  check('a 2-letter code → 422', (await root.post('/admin/field-staff', { email: 'rahul@fld.test', code: 'R9', reason: 'new field staff' })).status === 422);
  check('a shop’s referral code as the staff code → 422', (await root.post('/admin/field-staff', { email: 'rahul@fld.test', code: shopCode, reason: 'new field staff' })).status === 422);
  const add = await root.post('/admin/field-staff', { email: 'Rahul@Fld.test', code: 'rahul 90', reason: 'new field staff' });
  const list = data<{ email: string; code: string; name: string; hasPassword: boolean }[]>(add);
  check('added → code RAHUL90, name from the email until set, no password', add.status === 201 && list[0]?.code === 'RAHUL90' && list[0].email === 'rahul@fld.test' && list[0].name === 'rahul' && !list[0].hasPassword, code(add));
  check('the same code again → 422 · the same email again → 409', (await root.post('/admin/field-staff', { email: 'other@fld.test', code: 'RAHUL90', reason: 'new field staff' })).status === 422 && (await root.post('/admin/field-staff', { email: 'rahul@fld.test', code: 'OTHER1', reason: 'new field staff' })).status === 409);
  const welcome = await EmailJobModel.findOne({ kind: 'field_welcome', to: 'rahul@fld.test' }).lean();
  check('welcome email: the code, 90 days and the sign-in link', Boolean(welcome?.text.includes('RAHUL90') && welcome.text.includes('90-day') && welcome.text.includes('/field')));
  check('admin audit has it', Boolean(await AdminAuditModel.exists({ action: 'field_staff_add' })));

  section('2. Sign-in: email code first, then a password — no authenticator');
  const f = h.client(ADMIN);
  check('no password yet → 401', (await f.post('/field/auth/password', { email: 'rahul@fld.test', password: 'whatever1' })).status === 401);
  check('a stranger asks for a code → same answer, no email', (await f.post('/field/auth/code', { email: 'nobody@fld.test' })).status === 200 && !(await EmailJobModel.exists({ to: 'nobody@fld.test' })));
  await h.seedOtp('rahul@fld.test', '246810', 'field');
  const v = await f.post('/field/auth/verify', { email: 'rahul@fld.test', otp: '246810' });
  check('email code → signed in', v.status === 200 && data<{ code: string }>(v).code === 'RAHUL90', code(v));
  check('the field cookie opens no admin console → 401', (await f.get('/admin/overview')).status === 401);
  check('an admin session opens no field portal → 401', (await root.get('/field/me')).status === 401);
  check('profile: name and phone', (await f.put('/field/me', { name: 'Rahul Sen', phone: '98300 55555' })).status === 200 && data<{ name: string }>(await f.get('/field/me')).name === 'Rahul Sen');
  check('a short password → 422', (await f.put('/field/me/password', { password: 'short' })).status === 422);
  check('first password after the email code → 200', (await f.put('/field/me/password', { password: 'Kolkata#2026' })).status === 200);
  const p = h.client(ADMIN);
  const pw = await p.post('/field/auth/password', { email: 'rahul@fld.test', password: 'Kolkata#2026' });
  check('password sign-in → 200, a 7-day cookie', pw.status === 200 && /Max-Age=604800/i.test(String(pw.headers.get('set-cookie'))), String(pw.headers.get('set-cookie')));
  check('changing it from a password session needs the current one → 422', (await p.put('/field/me/password', { password: 'Another#2026' })).status === 422);
  for (let i = 0; i < 5; i++) await h.client(ADMIN).post('/field/auth/password', { email: 'rahul@fld.test', password: 'wrong-pass' });
  check('5 wrong passwords → locked, even the right one', (await h.client(ADMIN).post('/field/auth/password', { email: 'rahul@fld.test', password: 'Kolkata#2026' })).status === 401);
  await h.seedOtp('rahul@fld.test', '135799', 'field');
  check('…an email code still works', (await h.client(ADMIN).post('/field/auth/verify', { email: 'rahul@fld.test', otp: '135799' })).status === 200);

  section('3. A shop that joins with the code gets the staff trial');
  const o1 = await h.signIn('owner1@fld.test');
  const chk = data<{ kind: string; trialDays: number; staffName: string }>(await o1.get('/referral/check?code=rahul-90'));
  check('onboarding check: staff code, 90 days, Rahul Sen', chk.kind === 'staff' && chk.trialDays === 90 && chk.staffName === 'Rahul Sen', JSON.stringify(chk));
  const s1 = await o1.post('/shops', signup('Staff Code Pharmacy', 'rahul 90'));
  const id1 = data<{ id: string }>(s1).id;
  check('signup with the code → trial ends in 90 days', s1.status === 201 && days((await subOf(id1))?.endDate ?? 0) === 90, code(s1));
  const o2 = await h.signIn('owner2@fld.test');
  check('a shop referral code still gives the normal 30 days', days((await subOf(data<{ id: string }>(await o2.post('/shops', signup('Shop Code Pharmacy', shopCode))).id))?.endDate ?? 0) === 30);
  check('the shop code check says “shop”', data<{ kind: string }>(await o2.get(`/referral/check?code=${shopCode}`)).kind === 'shop');
  let mine = data<Mine>(await f.get('/field/shops'));
  check('Rahul sees 1 shop, on trial, from signup', mine.totals.joined === 1 && mine.totals.onTrial === 1 && mine.shops[0]?.source === 'signup' && mine.shops[0].shopName === 'Staff Code Pharmacy', JSON.stringify(mine.totals));

  section('4. Rahul fills a shop for its owner, who checks it and agrees');
  const bad = await f.post('/field/drafts', { email: 'owner3@fld.test', owner: { name: 'Mita Das', phone: '98300 66666' }, shop: { ...shop('Das Medical'), drugLicenseExpiry: '2024-01' } });
  check('an expired licence → 422', bad.status === 422);
  const d = await f.post('/field/drafts', { email: 'Owner3@fld.test', owner: { name: 'Mita Das', phone: '98300 66666' }, shop: shop('Das Medical') });
  check('draft → 201, the owner gets an email to check and start', d.status === 201 && Boolean(await EmailJobModel.exists({ kind: 'shop_draft', to: 'owner3@fld.test' })), code(d));
  const o3 = await h.signIn('owner3@fld.test');
  const draft = data<{ staffName: string; code: string; form: { owner: { name: string }; shop: { name: string; drugLicenseExpiry: string } } } | null>(await o3.get('/shops/draft'));
  check('the owner’s onboarding gets the form, Rahul’s name and code', draft?.form.shop.name === 'Das Medical' && draft.form.shop.drugLicenseExpiry === '2031-03' && draft.code === 'RAHUL90' && draft.staffName === 'Rahul Sen');
  check('another signed-in person sees no draft', data<unknown>(await o2.get('/shops/draft')) === null);
  const s3 = await o3.post('/shops', { ...signup('Das Medical', draft?.code), owner: { name: 'Mita Das', phone: '98300 66666' } });
  check('the owner agrees → shop made, 90-day trial', s3.status === 201 && days((await subOf(data<{ id: string }>(s3).id))?.endDate ?? 0) === 90, code(s3));
  mine = data<Mine>(await f.get('/field/shops'));
  check('Rahul: 2 shops, Das Medical “onboarded”, the draft done', mine.totals.joined === 2 && mine.shops.some((x) => x.shopName === 'Das Medical' && x.source === 'onboarded') && mine.drafts.some((x) => x.shopName === 'Das Medical' && x.status === 'done'));
  check('no draft left for the owner', data<unknown>(await o3.get('/shops/draft')) === null);

  section('5. The code added later: by the owner, by the admin');
  const o4 = await h.signIn('owner4@fld.test');
  o4.shopId = data<{ id: string }>(await o4.post('/shops', signup('Forgot Pharmacy'))).id;
  const late = await o4.post('/shop/staff-code', { code: 'RAHUL90' });
  check('the owner adds it → trial to 90 days from signup', late.status === 200 && data<{ trialGiven: boolean }>(late).trialGiven && days((await subOf(o4.shopId))?.endDate ?? 0) === 90, code(late));
  check('a second code → 409', (await o4.post('/shop/staff-code', { code: 'RAHUL90' })).status === 409);
  const o5 = await h.signIn('owner5@fld.test');
  const id5 = data<{ id: string }>(await o5.post('/shops', signup('Paid Pharmacy'))).id;
  await root.post('/admin/payments/manual', { shopId: id5, planCode: 'monthly', reference: 'UTR112233', reason: 'Bank transfer received' });
  const paidEnd = (await subOf(id5))?.endDate;
  check('support can see the code panel, adding needs a reason', (await help.get(`/admin/shops/${id5}/staff-code`)).status === 200 && (await help.post(`/admin/shops/${id5}/staff-code`, { code: 'RAHUL90' })).status === 422);
  const adm = await help.post(`/admin/shops/${id5}/staff-code`, { code: 'RAHUL90', reason: 'owner forgot the code' });
  check('paid shop: the code counts for Rahul, the plan does not change', adm.status === 200 && !data<{ trialGiven: boolean }>(adm).trialGiven && (await subOf(id5))?.endDate.getTime() === paidEnd?.getTime(), code(adm));
  mine = data<Mine>(await f.get('/field/shops'));
  check('Rahul: 4 shops, 1 paying', mine.totals.joined === 4 && mine.totals.paying === 1, JSON.stringify(mine.totals));

  section('6. Turned off');
  const staffId = String((await FieldStaffModel.findOne({ code: 'RAHUL90' }).lean())?._id);
  check('reset password → no password', data<{ hasPassword: boolean }[]>(await root.post(`/admin/field-staff/${staffId}`, { action: 'reset-password', reason: 'forgot password' }))[0]?.hasPassword === false);
  check('disable → 200', (await root.post(`/admin/field-staff/${staffId}`, { action: 'disable', reason: 'left the company' })).status === 200);
  check('his session ends → 401', (await f.get('/field/shops')).status === 401);
  const o6 = await h.signIn('owner6@fld.test');
  check('his code no longer gives a trial → 422 at signup', (await o6.post('/shops', signup('Late Pharmacy', 'RAHUL90'))).status === 422);

  await h.close();
  finish();
}

main().catch(crash);
