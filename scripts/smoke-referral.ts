// D80 checks: referral codes at signup, the new shop's discount, the referrer's reward after paid months in a row,
// one discount per payment, and the admin setting the terms and the referrer.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const fieldOf = (r: Res) => ((r.json.error?.details as { field: string; message: string }[] | undefined) ?? [])[0];

const shopBody = (name: string, referralCode?: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
  ...(referralCode === undefined ? {} : { referralCode }),
});

interface Offer { kind: 'welcome' | 'reward'; pct: number; until: string | null }
interface Sub { status: string; offer: Offer | null; plans: { code: string; price: number; pay: number }[]; endDate: string }
interface Ref { id: string; referee: { id: string; name: string }; referrer: { id: string; name: string }; source: string; status: string; streakDays: number; qualifyDays: number; reward: string; rewardPct: number; welcome: { pct: number; used: boolean } }
interface Mine { enabled: boolean; code: string; newShopPct: number; newShopDays: number; rewardPct: number; qualifyMonths: number; offer: Offer | null; referredBy: Ref | null; referred: Ref[]; rewardsReady: number }
interface Pay { id: string; amount: number; gst: number; invoiceNumber: string | null; discount: { kind: string; pct: number; off: number; listAmount: number } | null }

const DAY = 86_400_000;

async function main() {
  const h = await startHarness();
  const { ReferralModel } = await import('../src/modules/referral/referral.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { SubscriptionPaymentModel } = await import('../src/modules/subscription/billing.model.js');
  const { ShopModel } = await import('../src/modules/shops/shop.model.js');
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { totpAt } = await import('../src/utils/totp.js');

  const ownerOf = async (email: string, name: string, ref?: string) => {
    const c = await h.signIn(email);
    const r = await c.post('/shops', shopBody(name, ref));
    if (r.status !== 201) throw new Error(`shop ${name}: ${code(r)}`);
    const id = data<{ id: string }>(r).id;
    c.shopId = id;
    return Object.assign(c, { id });
  };
  type Owner = Awaited<ReturnType<typeof ownerOf>>;
  const mine = async (o: Owner) => data<Mine>(await o.get('/referral'));
  const sub = async (o: Owner) => data<Sub>(await o.get('/subscription'));
  const payPlan = async (o: Owner, planCode: string) => {
    const ord = data<{ orderId: string; amount: number }>(await o.post('/subscription/order', { planCode }));
    const r = await o.post('/subscription/test-pay', { orderId: ord.orderId });
    if (r.status !== 200) throw new Error(`pay: ${code(r)}`);
    return { order: ord, pay: data<Pay>(r) };
  };
  const refOf = async (shopId: string) => ReferralModel.findOne({ refereeShopId: shopId }).lean();
  /** The plan ran out 10 days ago (past the 7 days' grace): the next payment starts a new run. */
  const lapse = async (shopId: string) => SubscriptionModel.updateOne({ shopId }, { $set: { endDate: new Date(Date.now() - 10 * DAY) } });

  section('1. Every shop has its own code; a new owner types it at signup');
  const a = await ownerOf('arjun@ref1.test', 'Shri Ram Medical Store');
  const ma = await mine(a);
  check('the code is the name and 3 digits (SHRIR482), and the program is on with 10% / 30 days / 10% / 3 months', /^SHRIR[2-9]{3}$/.test(ma.code) && ma.enabled && ma.newShopPct === 10 && ma.newShopDays === 30 && ma.rewardPct === 10 && ma.qualifyMonths === 3, JSON.stringify(ma));
  check('asked again → the same code', (await mine(a)).code === ma.code);
  const bUser = await h.signIn('bina@ref1.test');
  const typed = `${ma.code.slice(0, 4).toLowerCase()} ${ma.code.slice(4)}`;
  const chk = await bUser.get(`/referral/check?code=${encodeURIComponent(typed)}`);
  check('typed in small letters with a space → found: Shri Ram, 10% within 30 days', chk.status === 200 && data<{ shopName: string; newShopPct: number }>(chk).shopName === 'Shri Ram Medical Store' && data<{ newShopPct: number }>(chk).newShopPct === 10, code(chk));
  const own = await a.get(`/referral/check?code=${ma.code}`);
  check('the owner checks their own code → 422 "your own shop’s code"', own.status === 422 && /own shop/.test(fieldOf(own)?.message ?? ''), code(own));
  check('a code nobody has → 422', (await bUser.get('/referral/check?code=NOPE999')).status === 422);
  const badShop = await bUser.post('/shops', shopBody('Bina Medicos', 'NOPE999'));
  check('signup with a wrong code → 422 on referralCode, and no shop is made', badShop.status === 422 && fieldOf(badShop)?.field === 'body.referralCode' && !(await ShopModel.exists({ name: 'Bina Medicos' })), code(badShop));
  const okShop = await bUser.post('/shops', shopBody('Bina Medicos', typed));
  const b = Object.assign(bUser, { id: data<{ id: string }>(okShop).id });
  b.shopId = b.id;
  const rb = await refOf(b.id);
  check('signup with the code → the shop, and a referral from Shri Ram (signup, 10%, 30 days, 90 days to qualify)', okShop.status === 201 && rb?.source === 'signup' && String(rb.referrerShopId) === a.id && rb.newShopPct === 10 && rb.qualifyDays === 90 && Math.abs(rb.newShopUntil.getTime() - Date.now() - 30 * DAY) < 60_000, code(okShop));
  const a2 = await a.post('/shops', shopBody('Shri Ram Branch 2', ma.code));
  check('the same owner opening a second shop with their own code → 422', a2.status === 422 && fieldOf(a2)?.field === 'body.referralCode', code(a2));

  section('2. The new shop’s welcome: off its first payment only');
  const sb = await sub(b);
  const monthly = sb.plans.find((p) => p.code === 'monthly');
  check('Plan shows the welcome 10%: Monthly ₹799 → pay ₹719 (whole rupees)', sb.offer?.kind === 'welcome' && sb.offer.pct === 10 && monthly?.price === 79_900 && monthly.pay === 71_900, JSON.stringify(sb.offer));
  check('Shri Ram itself has nothing to take yet', (await sub(a)).offer === null);
  const p1 = await payPlan(b, 'monthly');
  check('the order and the payment are ₹719; GST is worked out on ₹719', p1.order.amount === 71_900 && p1.pay.amount === 71_900 && p1.pay.gst === 71_900 - Math.round((71_900 * 100) / 118), JSON.stringify(p1.pay));
  check('the payment says what came off: welcome 10% = ₹80 of ₹799', p1.pay.discount?.kind === 'welcome' && p1.pay.discount.pct === 10 && p1.pay.discount.off === 8_000 && p1.pay.discount.listAmount === 79_900);
  const inv = await b.get(`/subscription/payments/${p1.pay.id}/invoice`);
  check('its tax invoice downloads', inv.status === 200 && inv.headers.get('content-type') === 'application/pdf', code(inv));
  const sb2 = await sub(b);
  check('after the first payment the welcome is gone: full price again', sb2.offer === null && sb2.plans.find((p) => p.code === 'monthly')?.pay === 79_900);
  const rb2 = await refOf(b.id);
  check('referral: welcome used, 30 days paid of 90, still waiting', Boolean(rb2?.welcomePaymentId) && rb2?.streakDays === 30 && rb2.status === 'pending' && rb2.reward === 'none');

  section('3. The referrer’s reward: 3 months in a row; a lapse starts again');
  await payPlan(b, 'monthly');
  check('second month while the first runs → 60 days in a row, still waiting', (await refOf(b.id))?.streakDays === 60 && (await refOf(b.id))?.status === 'pending');
  await lapse(b.id);
  await payPlan(b, 'monthly');
  check('the plan ran out, then paid → the run starts again at 30 (not 90)', (await refOf(b.id))?.streakDays === 30 && (await refOf(b.id))?.status === 'pending', String((await refOf(b.id))?.streakDays));
  check('Shri Ram still has no reward', (await sub(a)).offer === null && (await mine(a)).rewardsReady === 0);
  await payPlan(b, 'monthly');
  await payPlan(b, 'monthly');
  const rb3 = await refOf(b.id);
  check('three months in a row → qualified; Shri Ram’s reward is ready', rb3?.status === 'qualified' && rb3.streakDays === 90 && rb3.reward === 'ready' && Boolean(rb3.qualifiedAt));
  const ma2 = await mine(a);
  check('Shri Ram sees Bina Medicos as qualified, 1 reward ready', ma2.rewardsReady === 1 && ma2.referred[0]?.referee.name === 'Bina Medicos' && ma2.referred[0].status === 'qualified');
  check('Bina sees who referred it', (await mine(b)).referredBy?.referrer.name === 'Shri Ram Medical Store');
  const sa = await sub(a);
  check('Shri Ram’s plan screen: reward 10% → Yearly ₹7,990 → pay ₹7,191', sa.offer?.kind === 'reward' && sa.offer.pct === 10 && sa.plans.find((p) => p.code === 'yearly')?.pay === 719_100, JSON.stringify(sa.offer));
  const pa = await payPlan(a, 'monthly');
  check('Shri Ram pays Monthly with the reward → ₹719, reward used on that payment', pa.pay.amount === 71_900 && pa.pay.discount?.kind === 'reward' && (await refOf(b.id))?.reward === 'used' && String((await refOf(b.id))?.rewardPaymentId) === pa.pay.id);
  check('the next payment is full price again (one reward, one payment)', (await sub(a)).offer === null);

  section('4. Yearly qualifies at once; two rewards are two payments');
  const d = await ownerOf('dev@ref1.test', 'Dev Pharmacy', ma.code);
  const e = await ownerOf('esha@ref1.test', 'Esha Medicals', ma.code);
  const pd = await payPlan(d, 'yearly');
  check('Dev pays Yearly with the welcome → ₹7,191, and qualifies with one payment (365 ≥ 90)', pd.pay.amount === 719_100 && (await refOf(d.id))?.status === 'qualified');
  await payPlan(e, 'yearly');
  check('Esha too → Shri Ram has 2 rewards ready', (await mine(a)).rewardsReady === 2);
  const pa2 = await payPlan(a, 'monthly');
  check('Shri Ram pays once → only one reward is spent (the older, Dev’s), one still waits', pa2.pay.discount?.kind === 'reward' && (await refOf(d.id))?.reward === 'used' && (await refOf(e.id))?.reward === 'ready' && (await mine(a)).rewardsReady === 1);

  section('5. A fully refunded month doesn’t count; the welcome has a deadline');
  const f = await ownerOf('farid@ref1.test', 'Farid Drug House', ma.code);
  const pf = await payPlan(f, 'monthly');
  await SubscriptionPaymentModel.updateOne({ _id: pf.pay.id }, { $set: { refunded: pf.pay.amount } });
  await payPlan(f, 'monthly');
  await payPlan(f, 'monthly');
  check('3 months paid but the first was refunded in full → 60 days, not qualified', (await refOf(f.id))?.streakDays === 60 && (await refOf(f.id))?.status === 'pending', String((await refOf(f.id))?.streakDays));
  const late = await ownerOf('gita@ref1.test', 'Gita Medical Hall', ma.code);
  await ReferralModel.updateOne({ refereeShopId: late.id }, { $set: { newShopUntil: new Date(Date.now() - DAY) } });
  check('a new shop that pays after its 30 days → no welcome', (await sub(late)).offer === null && (await sub(late)).plans.find((p) => p.code === 'monthly')?.pay === 79_900);

  section('6. Admin: the terms, and the referrer an owner forgot to type');
  await AdminUserModel.create({ email: 'boss@medshop.test', name: 'Boss', role: 'super' });
  await AdminUserModel.create({ email: 'help@medshop.test', name: 'Helpdesk', role: 'support' });
  await AdminUserModel.create({ email: 'view@medshop.test', name: 'Viewer', role: 'viewer' });
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const s = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' })).secret ?? '';
    await c.post('/admin/auth/totp', { code: totpAt(s, Math.floor(Date.now() / 30_000)) });
    return c;
  };
  const boss = await login('boss@medshop.test');
  const help = await login('help@medshop.test');
  const viewer = await login('view@medshop.test');
  const list = await viewer.get('/admin/referrals');
  check('every admin sees the referral list: 5 referrals, newest first', list.status === 200 && data<{ rows: Ref[] }>(list).rows.length === 5 && data<{ rows: Ref[] }>(list).rows[0]?.referee.name === 'Gita Medical Hall', code(list));
  const terms = { enabled: true, newShopPct: 5, newShopDays: 60, rewardPct: 15, qualifyMonths: 1 };
  check('support can’t change the terms → 403', (await help.put('/admin/referrals/settings', { settings: terms, reason: 'New offer for October' })).status === 403);
  check('no reason → 422', (await boss.put('/admin/referrals/settings', { settings: terms, reason: '' })).status === 422);
  check('more than 50% → 422', (await boss.put('/admin/referrals/settings', { settings: { ...terms, rewardPct: 60 }, reason: 'New offer for October' })).status === 422);
  const saved = await boss.put('/admin/referrals/settings', { settings: terms, reason: 'New offer for October' });
  check('super sets 5% within 60 days, 15% after 1 month → saved and on the admin log', saved.status === 200 && (await mine(a)).rewardPct === 15 && Boolean(await AdminAuditModel.exists({ action: 'referral_settings', reason: 'New offer for October' })), code(saved));
  check('a promise already made doesn’t move: Shri Ram’s waiting reward is still 10%', (await sub(a)).offer?.pct === 10);

  const g = await ownerOf('hari@ref1.test', 'Hari Medicine Centre');
  check('a shop that skipped the code has no discount', (await sub(g)).offer === null && !(await refOf(g.id)));
  const found = await help.get(`/admin/shops?q=${ma.code.toLowerCase()}`);
  check('admin finds Shri Ram by its code', data<{ id: string }[]>(found).map((s) => s.id).join() === a.id, code(found));
  check('viewer can’t set a referrer → 403', (await viewer.put(`/admin/shops/${g.id}/referrer`, { referrerShopId: a.id, reason: 'Owner called us' })).status === 403);
  check('a shop as its own referrer → 422', (await help.put(`/admin/shops/${g.id}/referrer`, { referrerShopId: g.id, reason: 'Owner called us' })).status === 422);
  const loop = await help.put(`/admin/shops/${a.id}/referrer`, { referrerShopId: b.id, reason: 'Owner called us' });
  check('Bina was referred by Shri Ram → Shri Ram can’t be Bina’s → 422', loop.status === 422 && /other way round/.test(fieldOf(loop)?.message ?? ''), code(loop));
  const set = await help.put(`/admin/shops/${g.id}/referrer`, { referrerShopId: a.id, reason: 'Owner called us' });
  const rg = await refOf(g.id);
  check('support sets Shri Ram as Hari’s referrer → saved with today’s terms (5%, 30 days to qualify)', set.status === 200 && rg?.source === 'admin' && rg.newShopPct === 5 && rg.qualifyDays === 30 && rg.rewardPct === 15 && data<{ referral: { referredBy: Ref | null } }>(set).referral.referredBy?.referrer.name === 'Shri Ram Medical Store', code(set));
  const sg = await sub(g);
  check('Hari now gets 5% off its first payment: ₹799 → ₹759', sg.offer?.kind === 'welcome' && sg.offer.pct === 5 && sg.plans.find((p) => p.code === 'monthly')?.pay === 75_900, JSON.stringify(sg.offer));
  const moved = await help.put(`/admin/shops/${g.id}/referrer`, { referrerShopId: b.id, reason: 'Wrong shop, it was Bina' });
  check('changed to Bina → saved; the shop’s own log says who it was before', moved.status === 200 && String((await refOf(g.id))?.referrerShopId) === b.id && Boolean(await AdminAuditModel.exists({ shopId: g.id, action: 'referral_set', text: { $regex: 'was Shri Ram' } })));
  await payPlan(g, 'monthly');
  check('Hari pays one month (1 month needed now) → qualified, Bina’s 15% reward is ready', (await refOf(g.id))?.status === 'qualified' && (await sub(b)).offer?.pct === 15);
  const settled = await help.put(`/admin/shops/${g.id}/referrer`, { referrerShopId: a.id, reason: 'Change it back' });
  check('after the reward is earned the referrer can’t change → 409', settled.status === 409, code(settled));
  const acc = await (async () => {
    await AdminUserModel.create({ email: 'acc@medshop.test', name: 'Accounts', role: 'accounts' });
    return login('acc@medshop.test');
  })();
  const man = await acc.post('/admin/payments/manual', { shopId: b.id, planCode: 'monthly', reference: 'UTR 4455', reason: 'Paid by bank transfer' });
  check('a payment the accounts desk records takes the reward too: ₹799 − 15% = ₹679', man.status === 200 && data<Pay>(man).amount === 67_900 && data<Pay>(man).discount?.kind === 'reward', code(man));
  const removeFrom = await ownerOf('isha@ref1.test', 'Isha Pharma');
  await help.put(`/admin/shops/${removeFrom.id}/referrer`, { referrerShopId: a.id, reason: 'Owner called us' });
  const rm = await help.put(`/admin/shops/${removeFrom.id}/referrer`, { referrerShopId: null, reason: 'Owner was wrong' });
  check('a waiting referral can be removed', rm.status === 200 && !(await refOf(removeFrom.id)) && (await sub(removeFrom)).offer === null, code(rm));
  check('remove again → 409', (await help.put(`/admin/shops/${removeFrom.id}/referrer`, { referrerShopId: null, reason: 'Owner was wrong' })).status === 409);
  const page = data<{ referral: { code: string; referred: Ref[] } }>(await viewer.get(`/admin/shops/${a.id}`));
  check('the shop page shows its code and the shops it brought (Dev, Esha, Farid, Gita, Bina)', page.referral.code === ma.code && page.referral.referred.length === 5);

  section('7. Program off: no new codes, earned rewards still count');
  await boss.put('/admin/referrals/settings', { settings: { ...terms, enabled: false }, reason: 'Pause the offer' });
  const meta = data<{ referral: { enabled: boolean } }>(await (await h.signIn('jai@ref1.test')).get('/shops/onboarding'));
  check('onboarding hides the box (enabled: false)', !meta.referral.enabled);
  const j = await h.signIn('jai@ref1.test');
  const off = await j.post('/shops', shopBody('Jai Medical', ma.code));
  check('signup with a code while off → 422 on referralCode', off.status === 422 && fieldOf(off)?.field === 'body.referralCode', code(off));
  check('Shri Ram’s reward from Esha still applies', (await sub(a)).offer?.kind === 'reward');

  await h.close();
  finish();
}

main().catch(crash);
