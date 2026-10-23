// D100 checks: partners (field staff) — added by a super admin with email + code, sign in by password or email code (no
// authenticator, 7-day session), the code gives a new shop the partner trial, drafts the owner confirms, a code added
// later; each code its own trial, more codes, removed for good.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const DAY = 86_400_000;
const shop = (name: string) => ({ name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' });
const signup = (name: string, referralCode?: string) => ({ owner: { name: 'Rohit Agarwal', phone: '98300 41122' }, shop: shop(name), termsVersion: '2026-10', agree: true, ...(referralCode ? { referralCode } : {}) });
const days = (end: string | Date | number, start = Date.now()) => Math.round((new Date(end).getTime() - start) / DAY);
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

  section('7. Partners: each code its own trial, more codes, removed for good');
  type Row = { id: string; email: string; codes: { code: string; trialDays: number | null; gives: number }[]; sharePct?: unknown };
  const bad1 = await root.post('/admin/field-staff', { email: 'priya@fld.test', code: 'PRIYA120', trialDays: -1, reason: 'new partner' });
  const bad2 = await root.post('/admin/field-staff', { email: 'priya@fld.test', code: 'PRIYA120', trialDays: 2.5, reason: 'new partner' });
  const bad3 = await root.post('/admin/field-staff', { email: 'priya@fld.test', code: 'PRIYA120', sharePct: 20, reason: 'new partner' });
  check('trial -1 / 2.5 days → 422; no share field at all → 422', [bad1, bad2, bad3].every((r) => r.status === 422), [bad1, bad2, bad3].map(code).join(' | '));
  const pa = await root.post('/admin/field-staff', { email: 'priya@fld.test', code: 'PRIYA120', trialDays: 120, reason: 'new partner' });
  const priya = data<Row[]>(pa).find((x) => x.email === 'priya@fld.test');
  check('added: PRIYA120 gives 120 days, nothing about a share', pa.status === 201 && priya?.codes[0]?.gives === 120 && priya.codes[0].trialDays === 120 && priya.sharePct === undefined, code(pa));
  const pw2 = await EmailJobModel.findOne({ kind: 'field_welcome', to: 'priya@fld.test' }).lean();
  check('welcome: a partner, 120-day trial, no share', Boolean(pw2?.text.includes('partner. Every shop you bring is counted as yours') && pw2.text.includes('120-day free trial') && !/share/i.test(pw2.text) && !/share/i.test(pw2.html)), pw2?.text);
  const pid = priya?.id ?? '';
  const o7 = await h.signIn('owner7@fld.test');
  check('onboarding check: PRIYA120 → 120 days', data<{ trialDays: number }>(await o7.get('/referral/check?code=PRIYA120')).trialDays === 120);
  const s7 = data<{ id: string }>(await o7.post('/shops', signup('Priya One Pharmacy', 'PRIYA120'))).id;
  check('signup with PRIYA120 → trial ends in 120 days', days((await subOf(s7))?.endDate ?? 0) === 120);
  check('support can’t change codes or remove → 403', (await help.post(`/admin/field-staff/${pid}/codes`, { code: 'PRIYA60', trialDays: 60, reason: 'two month offer' })).status === 403 && (await help.post(`/admin/field-staff/${pid}/remove`, { confirm: 'PRIYA120', reason: 'left us' })).status === 403);
  check('another partner’s code / a shop’s code as a new code → 422', (await root.post(`/admin/field-staff/${pid}/codes`, { code: 'RAHUL90', trialDays: 60, reason: 'two month offer' })).status === 422 && (await root.post(`/admin/field-staff/${pid}/codes`, { code: shopCode, reason: 'two month offer' })).status === 422);
  const more = await root.post(`/admin/field-staff/${pid}/codes`, { code: 'priya 60', trialDays: 60, reason: 'two month offer' });
  check('a second code PRIYA60 with 60 days', more.status === 200 && data<Row[]>(more).find((x) => x.id === pid)?.codes[1]?.gives === 60, code(more));
  check('…and an email to her with it', Boolean((await EmailJobModel.findOne({ kind: 'field_code', to: 'priya@fld.test' }).lean())?.text.includes('PRIYA60 — shops that join with it get a 60-day free trial')));
  const o8 = await h.signIn('owner8@fld.test');
  const s8 = data<{ id: string }>(await o8.post('/shops', signup('Priya Two Pharmacy', 'PRIYA60'))).id;
  check('signup with PRIYA60 → 60 days, counted for Priya with that code', days((await subOf(s8))?.endDate ?? 0) === 60 && data<{ code: string; staffName: string }>(await help.get(`/admin/shops/${s8}/staff-code`)).code === 'PRIYA60');
  const zero = await root.post(`/admin/field-staff/${pid}/codes`, { code: 'PRIYA0', trialDays: 0, reason: 'counts only, no trial' });
  check('a 0-day code: no free trial', zero.status === 200 && data<Row[]>(zero).find((x) => x.id === pid)?.codes[2]?.gives === 0 && data<{ trialDays: number }>(await o8.get('/referral/check?code=PRIYA0')).trialDays === 0, code(zero));
  check('…its email says “no free trial”', Boolean((await EmailJobModel.findOne({ kind: 'field_code', to: 'priya@fld.test', subject: /PRIYA0$/ }).lean())?.text.includes('PRIYA0 — shops that join with it get no free trial')));
  const o10 = await h.signIn('owner10@fld.test');
  const s10 = data<{ id: string }>(await o10.post('/shops', signup('Priya Zero Pharmacy', 'PRIYA0'))).id;
  const z10 = await subOf(s10);
  check('signup with PRIYA0 → the trial ends at signup (grace, then pay), counted for Priya', Boolean(z10) && Math.abs((z10?.endDate.getTime() ?? 0) - (z10?.startDate.getTime() ?? 1)) < 1000 && data<{ code: string }>(await help.get(`/admin/shops/${s10}/staff-code`)).code === 'PRIYA0');
  const reset = await root.post(`/admin/field-staff/${pid}/codes`, { code: 'PRIYA120', trialDays: null, reason: 'back to the standard offer' });
  const after = data<Row[]>(reset).find((x) => x.id === pid);
  check('main code back to Platform settings (90)', after?.codes[0]?.trialDays === null && after.codes[0].gives === 90 && data<{ trialDays: number }>(await o8.get('/referral/check?code=PRIYA120')).trialDays === 90, code(reset));
  check('the main code can’t be removed → 422', (await root.post(`/admin/field-staff/${pid}/codes`, { remove: 'PRIYA120', reason: 'clean up codes' })).status === 422);
  check('PRIYA60 removed → no longer a partner code at signup', (await root.post(`/admin/field-staff/${pid}/codes`, { remove: 'PRIYA60', reason: 'offer over' })).status === 200 && (await (await h.signIn('owner9@fld.test')).post('/shops', signup('Late Offer Pharmacy', 'PRIYA60'))).status === 422);
  await h.seedOtp('priya@fld.test', '864200', 'field');
  const pf = h.client(ADMIN);
  check('Priya signs in', (await pf.post('/field/auth/verify', { email: 'priya@fld.test', otp: '864200' })).status === 200);
  check('the wrong code typed to confirm → 422', (await root.post(`/admin/field-staff/${pid}/remove`, { confirm: 'PRIYA60', reason: 'left the partnership' })).status === 422);
  const rm = await root.post(`/admin/field-staff/${pid}/remove`, { confirm: 'priya120', reason: 'left the partnership' });
  check('removed for good → gone from the list, her session ends', rm.status === 200 && !data<Row[]>(rm).some((x) => x.id === pid) && !(await FieldStaffModel.exists({ email: 'priya@fld.test' })) && (await pf.get('/field/shops')).status === 401, code(rm));
  check('her shops keep their trial; no code shown for them', days((await subOf(s7))?.endDate ?? 0) === 120 && data<unknown>(await help.get(`/admin/shops/${s7}/staff-code`)) === null);
  check('audit has it', Boolean(await AdminAuditModel.exists({ action: 'field_staff_remove' })));
  check('PRIYA120 is free to give again → 201', (await root.post('/admin/field-staff', { email: 'meera@fld.test', code: 'PRIYA120', reason: 'new partner' })).status === 201);

  await h.close();
  finish();
}

main().catch(crash);
