// B8a checks: the date moves the plan (trial → grace → read-only), Razorpay orders, signed verify and webhook, once only.
import { createHmac, randomUUID } from 'node:crypto';
import { oldPriceList } from './lib/basic-plans';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error?.details as { reason?: string } | undefined)?.reason;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-11',
  agree: true,
});

interface Sub { status: string; planCode: string; next: { planCode: string; from: string } | null; endDate: string; daysLeft: number; maxUsers: number; readOnly: boolean; plans: { code: string; price: number }[]; payments: string }
interface Order { orderId: string; amount: number; price: number; charge: { pct: number; amount: number } | null }
interface Pay { invoiceNumber: string | null; status: string; replayed?: boolean; periodStart: string; periodEnd: string; id: string }

const DAY = 86_400_000;
const IST = 5.5 * 60 * 60 * 1000;
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
const KEY = 'smoke-razorpay-key-secret';
const HOOK = 'smoke-razorpay-webhook-secret';
const isoDay = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const near = (a: string | Date, b: number) => Math.abs(new Date(a).getTime() - b) < 60_000;

async function main() {
  const h = await startHarness();
  // Payment mechanics on the list before D113 (₹499 / ₹3,600, GST inside); the D113 list is smoke-plans'.
  await oldPriceList();
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { SubscriptionPaymentModel, WebhookEventModel } = await import('../src/modules/subscription/billing.model.js');
  const { fyOf } = await import('../src/utils/fy.js');
  const { GatewaySettingsModel, forgetGateway } = await import('../src/modules/subscription/gateway.js');
  const { pdfWords } = await import('../src/core/pdf-text.js');

  const owner = await h.signIn('rohit@sub1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    await c.post(`/invitations/${data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? ''}/accept`, { name: email.split('@')[0] });
    c.shopId = shop1;
    return c;
  };
  const manager = await invite('vikram@sub1.test', 'manager');
  const cashier = await invite('sunita@sub1.test', 'cashier');
  const sub = async () => data<Sub>(await owner.get('/subscription'));
  const expense = () => owner.post('/expenses', { clientRequestId: randomUUID(), date: isoDay(), category: 'Rent', description: '', amount: 100, paymentMode: 'UPI', fromDrawer: false, vendor: '', referenceNumber: '' });
  const fy = fyOf(new Date());

  section('1. A new shop is on a 30-day trial; plans are public');
  const s0 = await sub();
  check('trial, 30 days left, test payments on', s0.status === 'trial' && s0.daysLeft === 30 && s0.payments === 'test', JSON.stringify(s0));
  const plans = data<{ code: string; price: number; maxUsers: number }[]>(await h.client().get('/plans'));
  const pro = plans.find((p) => p.code === 'monthly');
  check('plans without signing in: Pro Monthly ₹499, Pro Yearly ₹3,600 — 10 users, the Pro package’s (D113)', plans.length === 2 && pro?.price === 49_900 && pro.maxUsers === 10 && plans.find((p) => p.code === 'yearly')?.price === 360_000);
  check('manager sees the plan, can’t buy → 403; cashier → 403', (await manager.get('/subscription')).status === 200 && (await manager.post('/subscription/order', { planCode: 'monthly' })).status === 403 && (await cashier.get('/subscription')).status === 403);

  section('2. Order → Checkout signature → verify');
  const o1r = await owner.post('/subscription/order', { planCode: 'monthly' });
  const o1 = data<Order>(o1r);
  // v1.51.0: the 2% online payment charge (unset = 2%) on top — 2% of ₹499 = ₹9.98.
  check('order: ₹499 + 2% online payment charge ₹9.98 = ₹508.98, a test order id', o1r.status === 201 && o1.price === 49_900 && o1.charge?.pct === 2 && o1.charge.amount === 998 && o1.amount === 50_898 && o1.orderId.startsWith('order_test_'), code(o1r));
  const p1 = await SubscriptionPaymentModel.findOne({ razorpayOrderId: o1.orderId }).lean();
  // ₹499 incl. 18% → GST 76.12; ₹9.98 incl. 18% → taxable 8.46, GST 1.52; each part keeps its own.
  check('payment row snapshots ₹508.98 with ₹76.12 + ₹1.52 GST inside, the charge on its own, status created', p1?.amount === 50_898 && p1.gst === 7_764 && p1.charge?.bps === 200 && p1.charge.amount === 998 && p1.charge.gst === 152 && p1.status === 'created', JSON.stringify(p1));
  check('unknown plan → 422', (await owner.post('/subscription/order', { planCode: 'gold' })).status === 422);
  const bad = await owner.post('/subscription/verify', { orderId: o1.orderId, paymentId: 'pay_ABC123', signature: 'a'.repeat(64) });
  check('a made-up signature → 400 BAD_SIGNATURE, nothing changes', bad.status === 400 && reason(bad) === 'BAD_SIGNATURE' && (await sub()).status === 'trial', code(bad));
  const payId = 'pay_ABC123';
  const v1 = await owner.post('/subscription/verify', { orderId: o1.orderId, paymentId: payId, signature: sign(KEY, `${o1.orderId}|${payId}`) });
  const s1 = await sub();
  check('signed verify → active Monthly, 30 days from today, 10 users', v1.status === 200 && s1.status === 'active' && s1.planCode === 'monthly' && s1.maxUsers === 10 && near(s1.endDate, Date.now() + 30 * DAY), `${code(v1)} ${JSON.stringify(s1)}`);
  check(`GST invoice MS-${fy}-00001`, data<Pay>(v1).invoiceNumber === `MS-${fy}-00001`);
  const again = await owner.post('/subscription/verify', { orderId: o1.orderId, paymentId: payId, signature: sign(KEY, `${o1.orderId}|${payId}`) });
  check('the same verify again → 200, replayed, no extra days', again.status === 200 && data<Pay>(again).replayed === true && (await sub()).endDate === s1.endDate);
  const other = await owner.post('/subscription/verify', { orderId: o1.orderId, paymentId: 'pay_OTHER9', signature: sign(KEY, `${o1.orderId}|pay_OTHER9`) });
  check('another payment on a paid order → 409 ALREADY_PAID', other.status === 409 && reason(other) === 'ALREADY_PAID');

  section('3. The webhook (browser closed after paying)');
  // The same plan again: another plan bought now starts after this one (D113, smoke-upgrade checks that).
  const o2 = data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' }));
  const hook = h.client({ origin: null });
  const event = (o: string, p: string, amount: number, type = 'payment.captured') => JSON.stringify({ event: type, payload: { payment: { entity: { id: p, order_id: o, amount, method: 'upi' } } } });
  const send = (raw: string, sig: string, id: string) => hook.raw('POST', '/webhooks/razorpay', raw, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': id });
  // ₹499 + 2% ₹9.98.
  const raw2 = event(o2.orderId, 'pay_MONTH2', 50_898);
  const forged = await send(raw2, sign('wrong-secret', raw2), 'evt_1');
  check('forged signature → 400, logged as invalid, nothing paid', forged.status === 400 && (await WebhookEventModel.findOne({ eventId: 'evt_1' }).lean())?.signatureValid === false && (await sub()).planCode === 'monthly');
  const w2 = await send(raw2, sign(HOOK, raw2), 'evt_2');
  const s2 = await sub();
  check('signed payment.captured → another month, added after the running one (30 + 30 days)', w2.status === 200 && s2.planCode === 'monthly' && s2.next === null && s2.maxUsers === 10 && near(s2.endDate, new Date(s1.endDate).getTime() + 30 * DAY), `${code(w2)} ${s2.endDate}`);
  check(`invoice MS-${fy}-00002 (one series across shops)`, (await SubscriptionPaymentModel.findOne({ razorpayOrderId: o2.orderId }).lean())?.invoiceNumber === `MS-${fy}-00002`);
  const dup = await send(raw2, sign(HOOK, raw2), 'evt_2');
  check('the same event again → duplicate, no extra month', dup.status === 200 && (dup.json.data as { result?: string } | undefined)?.result === 'duplicate' && (await sub()).endDate === s2.endDate);
  const o3 = data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' }));
  const raw3 = event(o3.orderId, 'pay_SHORT1', 100);
  const w3 = await send(raw3, sign(HOOK, raw3), 'evt_3');
  check('₹1 paid on a ₹499 order → not extended, payment failed', w3.status === 200 && (await SubscriptionPaymentModel.findOne({ razorpayOrderId: o3.orderId }).lean())?.status === 'failed' && (await sub()).endDate === s2.endDate);
  const o4 = data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' }));
  const raw4 = event(o4.orderId, 'pay_FAIL01', 50_898, 'payment.failed');
  await send(raw4, sign(HOOK, raw4), 'evt_4');
  check('payment.failed → marked failed', (await SubscriptionPaymentModel.findOne({ razorpayOrderId: o4.orderId }).lean())?.status === 'failed');
  const raw4b = event(o4.orderId, 'pay_RETRY1', 50_898);
  const before4 = (await sub()).endDate;
  await send(raw4b, sign(HOOK, raw4b), 'evt_5');
  check('a retry on the same order that captures → paid, a month added', (await SubscriptionPaymentModel.findOne({ razorpayOrderId: o4.orderId }).lean())?.status === 'paid' && near((await sub()).endDate, new Date(before4).getTime() + 30 * DAY));

  section('4. History and invoice');
  const hist = data<Pay[]>(await owner.get('/subscription/payments'));
  check('history: 3 paid, 1 failed', hist.filter((x) => x.status === 'paid').length === 3 && hist.filter((x) => x.status === 'failed').length === 1);
  const paid = hist.find((x) => x.invoiceNumber === `MS-${fy}-00001`);
  const pdf = await owner.raw('GET', `/subscription/payments/${paid?.id ?? ''}/invoice`);
  check('invoice PDF', pdf.status === 200 && (pdf.headers.get('content-type') ?? '').includes('pdf'));
  const text = (await pdfWords(pdf.body)).flat().map((w) => w.text).join(' ');
  // Line 1 the plan (₹422.88 + GST), line 2 the charge (₹8.46 + GST), total ₹508.98.
  check('the invoice has the charge as its own line: plan ₹422.88 taxable, “Online payment charge (2%)” ₹8.46 taxable, total ₹508.98', text.includes('Online payment charge (2%)') && text.includes('422.88') && text.includes('8.46') && text.includes('508.98') && text.includes('paid online through Razorpay'), text.slice(0, 600));
  check('history shows the charge on the payment', paid !== undefined && (paid as Pay & { charge?: { amount: number } | null }).charge?.amount === 998);

  section('4b. The admin raises, lowers or removes the charge');
  const setCharge = async (bps: number | null) => {
    await GatewaySettingsModel.updateOne({ _id: 'razorpay' }, bps === null ? { $unset: { chargeBps: 1 } } : { $set: { chargeBps: bps } }, { upsert: true });
    forgetGateway();
  };
  const oldOrder = data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' }));
  await setCharge(250);
  const o25 = data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' }));
  // 2.5% of ₹499 = ₹12.475 → ₹12.48.
  check('raised to 2.5% → a new order is ₹499 + ₹12.48 = ₹511.48; the plan screen says 2.5%', o25.charge?.pct === 2.5 && o25.charge.amount === 1_248 && o25.amount === 51_148 && (await sub() as Sub & { chargePct: number }).chargePct === 2.5, JSON.stringify(o25));
  const rawOld = event(oldOrder.orderId, 'pay_OLD001', 50_898);
  const wOld = await send(rawOld, sign(HOOK, rawOld), 'evt_old');
  check('an order made at 2% before the change still pays at ₹508.98', wOld.status === 200 && (await SubscriptionPaymentModel.findOne({ razorpayOrderId: oldOrder.orderId }).lean())?.status === 'paid');
  await setCharge(0);
  const o0 = data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' }));
  const p0 = await SubscriptionPaymentModel.findOne({ razorpayOrderId: o0.orderId }).lean();
  check('set to 0 → no charge: ₹499, ₹76.12 GST, nothing stored for the charge', o0.charge === null && o0.amount === 49_900 && p0?.amount === 49_900 && p0.gst === 7_612 && !p0.charge, JSON.stringify(o0));
  await owner.post('/subscription/test-pay', { orderId: o0.orderId });
  const pdf0 = await owner.raw('GET', `/subscription/payments/${String(p0?._id ?? '')}/invoice`);
  const text0 = (await pdfWords(pdf0.body)).flat().map((w) => w.text).join(' ');
  check('its invoice has no charge line', pdf0.status === 200 && !text0.includes('Online payment charge') && text0.includes('499.00'), text0.slice(0, 400));
  await setCharge(null);
  check('unset again → back to 2%', data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' })).charge?.amount === 998);
  const otherShop = await h.signIn('kakoli@sub2.test');
  otherShop.shopId = data<{ id: string }>(await otherShop.post('/shops', shopBody('Kakoli Pharmacy'))).id;
  check('another shop: can’t open the invoice or verify the order → 404', (await otherShop.raw('GET', `/subscription/payments/${paid?.id ?? ''}/invoice`)).status === 404 && (await otherShop.post('/subscription/verify', { orderId: o1.orderId, paymentId: payId, signature: sign(KEY, `${o1.orderId}|${payId}`) })).status === 404);

  section('5. The date moves the plan: grace, then read-only');
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { endDate: new Date(Date.now() - DAY) } });
  check('a day past the end → grace, still full access', (await sub()).status === 'grace' && (await expense()).status === 201);
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { endDate: new Date(Date.now() - 8 * DAY) } });
  const s5 = await sub();
  const blocked = await expense();
  check('8 days past → expired, read-only: writes → 402, reading works', s5.status === 'expired' && s5.readOnly && blocked.status === 402 && blocked.json.error?.code === 'SUBSCRIPTION_REQUIRED' && (await owner.get('/sales')).status === 200, code(blocked));
  check('the stored status moved too', (await SubscriptionModel.findOne({ shopId: shop1 }).lean())?.status === 'expired');
  const o5 = await owner.post('/subscription/order', { planCode: 'monthly' });
  const tp = await owner.post('/subscription/test-pay', { orderId: data<Order>(o5).orderId });
  const s6 = await sub();
  check('a read-only shop can still pay; the new month starts today', o5.status === 201 && tp.status === 200 && s6.status === 'active' && near(s6.endDate, Date.now() + 30 * DAY), `${code(o5)} ${code(tp)}`);
  check('writes work again', (await expense()).status === 201);

  section('6. Cancel');
  check('manager can’t cancel → 403; no reason → 422', (await manager.post('/subscription/cancel', { reason: 'closing' })).status === 403 && (await owner.post('/subscription/cancel', {})).status === 422);
  const c = await owner.post('/subscription/cancel', { reason: 'Shop closing for renovation' });
  check('owner cancels → read-only at once, data stays', c.status === 200 && data<Sub>(c).status === 'cancelled' && (await expense()).status === 402 && (await owner.get('/expenses')).status === 200);
  const o6 = await owner.post('/subscription/order', { planCode: 'monthly' });
  await owner.post('/subscription/test-pay', { orderId: data<Order>(o6).orderId });
  check('paying again brings it back', (await sub()).status === 'active' && (await expense()).status === 201);

  await h.close();
  finish();
}

main().catch(crash);
