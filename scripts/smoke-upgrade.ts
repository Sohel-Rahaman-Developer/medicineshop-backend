// D113 checks: Basic → Pro now for the days left (the difference only), Pro → Basic from the end of what is paid,
// what a payment opened is kept to the end of its period, one plan at a time, and an upgrade's refund goes back to Basic.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error?.details as { reason?: string } | undefined)?.reason;

const shopBody = (name: string) => ({
  owner: { name: 'Gita Paul', phone: '98300 41123' },
  shop: { name, address: { line1: '2 Lake Road', city: 'Kolkata', state: 'West Bengal', pincode: '700029' }, phone: '033 2466 0101', drugLicenseNumber: 'WB/KOL/RLF20B/2022/0101', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-11',
  agree: true,
});
const DAY = 86_400_000;
const near = (a: string | Date | undefined | null, b: number) => a != null && Math.abs(new Date(a).getTime() - b) < 120_000;
// Written out, not read from the code: the Basic the user asked for (10 Nov).
const BASIC = ['ai', 'report:sales-register', 'report:sales-summary', 'report:stock-on-hand', 'report:expiry', 'report:expired', 'report:purchase-register', 'report:supplier-outstanding', 'report:customer-outstanding', 'report:expenses'];
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

interface Quote { planCode: string; planName: string; days: number; price: number; amount: number; charge: { pct: number; amount: number } | null; from: { name: string; price: number; durationDays: number }; to: { price: number; durationDays: number } }
interface Sub { status: string; planCode: string; planName: string; tier: string | null; endDate: string; maxUsers: number; upgrade: Quote | null; next: { planCode: string; planName: string; from: string; until: string } | null; autopay: { status: string; running: boolean } | null }
interface Order { orderId: string; amount: number; price: number; charge: { pct: number; amount: number } | null; planName: string }
interface Pay { id: string; kind: string; upgradeFrom: string | null; planName: string; amount: number; gst: number; periodStart: string; periodEnd: string; refunded: number }

async function main() {
  const h = await startHarness();
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { AutopayModel, PackageModel, SubscriptionPaymentModel } = await import('../src/modules/subscription/billing.model.js');
  const { forgetPlanFeatures } = await import('../src/modules/subscription/plan-access.js');
  const { FEATURES } = await import('../src/modules/subscription/features.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { pdfWords } = await import('../src/core/pdf-text.js');
  const { ReferralModel } = await import('../src/modules/referral/referral.model.js');
  const ALL = [...FEATURES];

  const open = async (email: string, name: string) => {
    const c = await h.signIn(email);
    c.shopId = data<{ id: string }>(await c.post('/shops', shopBody(name))).id;
    return c;
  };
  const owner = await open('gita@up1.test', 'Lake Road Pharmacy');
  const sub = async (c = owner) => data<Sub>(await c.get('/subscription'));
  const ctx = async (c = owner) => data<{ features: string[]; subscription: { planCode: string; maxUsers: number } }>(await c.get('/shop/context'));
  const pay = async (c: typeof owner, planCode: string) => {
    const o = data<Order>(await c.post('/subscription/order', { planCode }));
    return { o, r: await c.post('/subscription/test-pay', { orderId: o.orderId }) };
  };
  const shopId = owner.shopId;
  const words = async (c: typeof owner, path: string) => (await pdfWords((await c.raw('GET', path)).body)).flat().map((w) => w.text).join(' ');

  section('1. Basic Monthly paid from the trial');
  const b1 = await pay(owner, 'basic-monthly');
  // ₹352.82 + 2% online payment charge ₹7.06 (705.64 paise rounds to 706) = ₹359.88.
  check('Basic Monthly ₹352.82 + ₹7.06 online charge = ₹359.88 → active Basic, 3 users', b1.o.amount === 35_988 && b1.r.status === 200 && (await sub()).planCode === 'basic-monthly' && (await ctx()).subscription.maxUsers === 3, `${String(b1.o.amount)} ${code(b1.r)}`);
  const paid1 = await SubscriptionPaymentModel.findOne({ razorpayOrderId: b1.o.orderId }).lean();
  check('the payment keeps what Basic opened when it was paid', same(paid1?.features ?? [], BASIC) && paid1?.kind === 'plan', JSON.stringify(paid1?.features));
  check('the Basic shop is offered Pro at once, for its 30 days', (await sub()).upgrade?.days === 30);
  const trialShop = await open('mira@up1.test', 'Mira Medicos');
  const noUp = await trialShop.post('/subscription/upgrade', {});
  check('a trial shop: no upgrade offered, POST /upgrade → 409 NO_UPGRADE', (await sub(trialShop)).upgrade === null && noUp.status === 409 && reason(noUp) === 'NO_UPGRADE', code(noUp));

  section('2. 18 days later, with Basic autopay on: Basic → Pro for the 12 days left');
  const end = Date.now() + 12 * DAY;
  await SubscriptionModel.updateOne({ shopId }, { $set: { endDate: new Date(end) } });
  const ap = data<{ subscriptionId: string; startAt: string | null }>(await owner.post('/subscription/autopay', { planCode: 'basic-monthly' }));
  await owner.post('/subscription/autopay/test-approve', { subscriptionId: ap.subscriptionId });
  check('Basic autopay on, first charge when the paid days end', (await sub()).autopay?.running === true && near(ap.startAt, end), JSON.stringify(ap));
  const q = (await sub()).upgrade;
  // (₹470.82 − ₹352.82) ÷ 30 days × 12 days = ₹118 × 12 ÷ 30 = ₹47.20; 2% of it = ₹0.94 (94.4 paise rounds to 94).
  check('the offer: Pro Monthly for the 12 days left — (₹470.82 − ₹352.82) ÷ 30 × 12 = ₹47.20, + ₹0.94 online charge = ₹48.14', q?.planCode === 'monthly' && q.days === 12 && q.price === 4_720 && q.charge?.amount === 94 && q.amount === 4_814 && q.from.price === 35_282 && q.to.price === 47_082 && q.from.durationDays === 30, JSON.stringify(q));
  const full = await owner.post('/subscription/order', { planCode: 'monthly' });
  check('paying a whole Pro month instead while Basic autopay runs → 409 AUTOPAY_ON (one plan at a time)', full.status === 409 && reason(full) === 'AUTOPAY_ON', code(full));
  const ur = await owner.post('/subscription/upgrade', {});
  const uo = data<Order>(ur);
  check('POST /subscription/upgrade → an order for ₹48.14, named Basic Monthly → Pro Monthly', ur.status === 201 && uo.amount === 4_814 && uo.price === 4_720 && uo.planName === 'Basic Monthly → Pro Monthly', code(ur));
  const up = await owner.post('/subscription/test-pay', { orderId: uo.orderId });
  const s2 = await sub();
  check('paid → Pro now, the same end date, 10 users, every feature', up.status === 200 && s2.planCode === 'monthly' && s2.tier === 'pro' && near(s2.endDate, end) && (await ctx()).subscription.maxUsers === 10 && same((await ctx()).features, ALL), `${code(up)} ${JSON.stringify(s2)}`);
  const ap2 = await AutopayModel.findOne({ rzpSubscriptionId: ap.subscriptionId }).lean();
  check('the Basic autopay stopped by itself, so it never charges Basic again', ap2?.status === 'cancelled' && (ap2.stopReason ?? '').startsWith('Upgraded to Pro Monthly') && (await sub()).autopay?.running === false, JSON.stringify([ap2?.status, ap2?.stopReason]));
  check('no second upgrade offered; POST /upgrade → 409', s2.upgrade === null && (await owner.post('/subscription/upgrade', {})).status === 409);
  const upPay = data<Pay[]>(await owner.get('/subscription/payments')).find((p) => p.kind === 'upgrade');
  // ₹47.20 holds ₹7.20 GST (₹40 + 18%); ₹0.94 holds ₹0.14 (₹0.80 + 18%).
  check('the payment: an upgrade from Basic Monthly, ₹48.14 with ₹7.34 GST inside, today → the same end date', upPay?.upgradeFrom === 'Basic Monthly' && upPay.amount === 4_814 && upPay.gst === 734 && near(upPay.periodStart, Date.now()) && near(upPay.periodEnd, end), JSON.stringify(upPay));
  const inv = await words(owner, `/subscription/payments/${upPay?.id ?? ''}/invoice`);
  check('its tax invoice says what it was: upgrade from Basic Monthly to Pro Monthly, the 12 days already paid for', inv.includes('upgrade from Basic Monthly to Pro Monthly') && inv.includes('The 12 days already paid for move to Pro Monthly'), inv.slice(0, 400));
  const log = await AuditLogModel.findOne({ shopId, module: 'subscription', text: /→ Pro Monthly for 12 days/ }).lean();
  check('the shop’s audit log: Basic Monthly → Pro Monthly for 12 days', Boolean(log), String(log?.text));

  section('3. Pro → Basic: paid now, starts when Pro ends');
  const d1 = await pay(owner, 'basic-monthly');
  const s3 = await sub();
  check('paying Basic while Pro runs: still Pro today, every feature; Basic from the day Pro ends, for 30 days', d1.r.status === 200 && s3.planCode === 'monthly' && same((await ctx()).features, ALL) && s3.next?.planCode === 'basic-monthly' && near(s3.next.from, end) && near(s3.next.until, end + 30 * DAY) && near(s3.endDate, end + 30 * DAY), JSON.stringify(s3));
  const pro = await owner.post('/subscription/order', { planCode: 'monthly' });
  check('now a Pro month → 409 NEXT_PLAN: Basic is already paid for next', pro.status === 409 && reason(pro) === 'NEXT_PLAN' && /Basic Monthly is already paid for from/.test(pro.json.error?.message ?? ''), code(pro));
  const auto = await owner.post('/subscription/autopay', { planCode: 'monthly' });
  check('…and Pro autopay → 409 NEXT_PLAN too', auto.status === 409 && reason(auto) === 'NEXT_PLAN', code(auto));
  const d2 = await pay(owner, 'basic-monthly');
  check('another Basic month adds to the Basic that comes next (60 days after Pro)', d2.r.status === 200 && near((await sub()).next?.until, end + 60 * DAY) && (await sub()).planCode === 'monthly');

  section('4. The day Pro ends: Basic takes over by itself');
  // 13 days on: every date moves 13 days back.
  const row = await SubscriptionModel.findOne({ shopId }).lean();
  const ago13 = (d?: Date | null) => new Date((d?.getTime() ?? 0) - 13 * DAY);
  await SubscriptionModel.updateOne({ shopId }, { $set: { endDate: ago13(row?.endDate), 'next.from': ago13(row?.next?.from), 'next.until': ago13(row?.next?.until), 'kept.until': ago13(row?.kept?.until) } });
  const c4 = await ctx();
  const row4 = await SubscriptionModel.findOne({ shopId }).lean();
  check('the shop opens on Basic: its features, 3 users, Pro screens closed', c4.subscription.planCode === 'basic-monthly' && same(c4.features, BASIC) && c4.subscription.maxUsers === 3 && (await owner.get('/brief')).status === 403, JSON.stringify(c4));
  check('saved once: no next plan left; what Basic opened is kept to its own end', row4?.planCode === 'basic-monthly' && !row4.next && near(row4.kept?.until, end - 13 * DAY + 60 * DAY), JSON.stringify(row4));

  section('5. What a payment opened stays till its period ends; a newly ticked feature opens at once');
  const noExpiry = BASIC.filter((f) => f !== 'report:expiry');
  await PackageModel.updateOne({ _id: 'basic' }, { $set: { features: [...noExpiry, 'labels'] } });
  forgetPlanFeatures();
  const c5 = await ctx();
  check('the admin unticks Expiry and ticks Labels on Basic: this paid shop keeps Expiry and gets Labels now', c5.features.includes('report:expiry') && c5.features.includes('labels') && (await owner.get('/labels/items')).json.error?.code !== 'PLAN_UPGRADE', JSON.stringify(c5.features));
  await SubscriptionModel.updateOne({ shopId }, { $set: { 'kept.until': new Date(Date.now() - DAY) } });
  const c6 = await ctx();
  check('once its paid period is over, Expiry closes (the next payment buys what Basic opens then)', !c6.features.includes('report:expiry') && c6.features.includes('labels'), JSON.stringify(c6.features));
  await PackageModel.updateOne({ _id: 'basic' }, { $set: { features: BASIC } });
  forgetPlanFeatures();

  section('6. Basic Yearly → Pro Yearly works on its own prices');
  const yr = await open('nila@up1.test', 'Nila Pharmacy');
  await SubscriptionModel.updateOne({ shopId: yr.shopId }, { $set: { planCode: 'basic-yearly', status: 'active', maxUsers: 3, endDate: new Date(Date.now() + 100 * DAY) } });
  const qy = (await sub(yr)).upgrade;
  // (₹4,233.84 − ₹2,817.84) ÷ 365 × 100 = ₹1,416 × 100 ÷ 365 = ₹387.945… → ₹387.95.
  check('100 days left: Pro Yearly for (₹4,233.84 − ₹2,817.84) ÷ 365 × 100 = ₹387.95', qy?.planCode === 'yearly' && qy.days === 100 && qy.price === 38_795, JSON.stringify(qy));
  await SubscriptionModel.updateOne({ shopId: yr.shopId }, { $set: { next: { planCode: 'yearly', from: new Date(Date.now() + 100 * DAY), until: new Date(Date.now() + 465 * DAY), maxUsers: 10, features: [] } } });
  check('Basic with Pro already paid for next: no upgrade offered (Pro comes on its day)', (await sub(yr)).upgrade === null && (await yr.post('/subscription/upgrade', {})).status === 409);
  await SubscriptionModel.updateOne({ shopId: yr.shopId }, { $set: { endDate: new Date(Date.now() - 2 * DAY) }, $unset: { next: 1 } });
  check('Basic ended 2 days ago (grace): no upgrade — pay for a plan instead', (await sub(yr)).status === 'grace' && (await sub(yr)).upgrade === null);
  await SubscriptionModel.updateOne({ shopId: yr.shopId }, { $set: { status: 'cancelled', endDate: new Date(Date.now() + 50 * DAY) } });
  check('a cancelled Basic with days left (read-only): no upgrade — paying a plan turns it back on', (await sub(yr)).status === 'cancelled' && (await sub(yr)).upgrade === null);

  section('7. Money back for an upgrade: the shop goes back to Basic, its days stay');
  const rf = await open('tara@up1.test', 'Tara Medical Hall');
  // Joined on another shop's code (no discount left), so its paid-days streak is counted.
  await ReferralModel.create({ referrerShopId: shopId, refereeShopId: rf.shopId, source: 'admin', code: 'LAKER001', newShopPct: 0, newShopUntil: new Date(Date.now() - DAY), rewardPct: 10, qualifyDays: 365, setBy: 'test' });
  await pay(rf, 'basic-monthly');
  const rfEnd = (await sub(rf)).endDate;
  const ro = data<Order>(await rf.post('/subscription/upgrade', {}));
  await rf.post('/subscription/test-pay', { orderId: ro.orderId });
  // 30 days left: (₹470.82 − ₹352.82) × 30 ÷ 30 = ₹118.00, + 2% = ₹2.36 → ₹120.36.
  check('a fresh Basic upgraded the same day: ₹118 + ₹2.36 = ₹120.36, Pro now', ro.amount === 12_036 && (await sub(rf)).planCode === 'monthly', String(ro.amount));
  const streak = (await ReferralModel.findOne({ refereeShopId: rf.shopId }).lean())?.streakDays;
  check('the referral streak counts the 30 paid days once — the upgrade moves them to Pro, it adds none', streak === 30, String(streak));
  await AdminUserModel.create({ email: 'acc@medshop.test', name: 'Accounts', role: 'accounts' });
  const acc = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('acc@medshop.test', '135790', 'admin');
  const secret = data<{ secret?: string }>(await acc.post('/admin/auth/verify', { email: 'acc@medshop.test', otp: '135790' })).secret ?? '';
  await acc.post('/admin/auth/totp', { code: totpAt(secret, Math.floor(Date.now() / 30_000)) });
  const upRow = await SubscriptionPaymentModel.findOne({ shopId: rf.shopId, kind: 'upgrade' }).lean();
  const back = await acc.post(`/admin/payments/${String(upRow?._id ?? '')}/refund`, { amount: 12_036, removeDays: false, reason: 'Wanted to stay on Basic' });
  const s7 = await sub(rf);
  check('a full refund of the upgrade → Basic Monthly again, the end date unchanged, no days taken', back.status === 200 && s7.planCode === 'basic-monthly' && s7.endDate === rfEnd && (await ctx(rf)).subscription.maxUsers === 3, `${code(back)} ${JSON.stringify(s7)}`);
  const cn = data<Pay[]>(await rf.get('/subscription/payments')).find((p) => p.kind === 'upgrade');
  const cnRow = await SubscriptionPaymentModel.findById(cn?.id).lean();
  const note = await words(rf, `/subscription/payments/${cn?.id ?? ''}/credit-notes/${String(cnRow?.refunds[0]?._id ?? '')}`);
  check('its credit note says so: back to Basic Monthly, plan days unchanged', note.includes('Back to Basic Monthly; plan days unchanged') && cnRow?.refunds[0]?.daysRemoved === 0, note.slice(0, 300));
  check('…and the upgrade can be offered again', (await sub(rf)).upgrade?.planCode === 'monthly');

  await h.close();
  finish();
}

main().catch(crash);
