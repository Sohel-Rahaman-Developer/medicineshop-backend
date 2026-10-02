// B8a checks: the date moves the plan (trial → grace → read-only), Razorpay orders, signed verify and webhook, once only.
import { createHmac, randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error?.details as { reason?: string } | undefined)?.reason;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});

interface Sub { status: string; planCode: string; endDate: string; daysLeft: number; maxUsers: number; readOnly: boolean; plans: { code: string; price: number }[]; payments: string }
interface Order { orderId: string; amount: number }
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
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { SubscriptionPaymentModel, WebhookEventModel } = await import('../src/modules/subscription/billing.model.js');
  const { fyOf } = await import('../src/utils/fy.js');

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

  section('1. A new shop is on a 14-day trial; plans are public');
  const s0 = await sub();
  check('trial, 14 days left, test payments on', s0.status === 'trial' && s0.daysLeft === 14 && s0.payments === 'test', JSON.stringify(s0));
  const plans = data<{ code: string; price: number; maxUsers: number }[]>(await h.client().get('/plans'));
  check('plans without signing in: Monthly ₹799 (5 users), Yearly ₹7,990', plans.length === 2 && plans[0]?.code === 'monthly' && plans[0].price === 79_900 && plans[0].maxUsers === 5 && plans[1]?.price === 799_000);
  check('manager sees the plan, can’t buy → 403; cashier → 403', (await manager.get('/subscription')).status === 200 && (await manager.post('/subscription/order', { planCode: 'monthly' })).status === 403 && (await cashier.get('/subscription')).status === 403);

  section('2. Order → Checkout signature → verify');
  const o1r = await owner.post('/subscription/order', { planCode: 'monthly' });
  const o1 = data<Order>(o1r);
  check('order: ₹799, a test order id', o1r.status === 201 && o1.amount === 79_900 && o1.orderId.startsWith('order_test_'), code(o1r));
  const p1 = await SubscriptionPaymentModel.findOne({ razorpayOrderId: o1.orderId }).lean();
  // ₹799 incl. 18% → taxable 677.12, GST 121.88.
  check('payment row snapshots ₹799 with ₹121.88 GST inside, status created', p1?.amount === 79_900 && p1.gst === 12_188 && p1.status === 'created');
  check('unknown plan → 422', (await owner.post('/subscription/order', { planCode: 'gold' })).status === 422);
  const bad = await owner.post('/subscription/verify', { orderId: o1.orderId, paymentId: 'pay_ABC123', signature: 'a'.repeat(64) });
  check('a made-up signature → 400 BAD_SIGNATURE, nothing changes', bad.status === 400 && reason(bad) === 'BAD_SIGNATURE' && (await sub()).status === 'trial', code(bad));
  const payId = 'pay_ABC123';
  const v1 = await owner.post('/subscription/verify', { orderId: o1.orderId, paymentId: payId, signature: sign(KEY, `${o1.orderId}|${payId}`) });
  const s1 = await sub();
  check('signed verify → active Monthly, 30 days from today, 5 users', v1.status === 200 && s1.status === 'active' && s1.planCode === 'monthly' && s1.maxUsers === 5 && near(s1.endDate, Date.now() + 30 * DAY), `${code(v1)} ${JSON.stringify(s1)}`);
  check(`GST invoice MS-${fy}-00001`, data<Pay>(v1).invoiceNumber === `MS-${fy}-00001`);
  const again = await owner.post('/subscription/verify', { orderId: o1.orderId, paymentId: payId, signature: sign(KEY, `${o1.orderId}|${payId}`) });
  check('the same verify again → 200, replayed, no extra days', again.status === 200 && data<Pay>(again).replayed === true && (await sub()).endDate === s1.endDate);
  const other = await owner.post('/subscription/verify', { orderId: o1.orderId, paymentId: 'pay_OTHER9', signature: sign(KEY, `${o1.orderId}|pay_OTHER9`) });
  check('another payment on a paid order → 409 ALREADY_PAID', other.status === 409 && reason(other) === 'ALREADY_PAID');

  section('3. The webhook (browser closed after paying)');
  const o2 = data<Order>(await owner.post('/subscription/order', { planCode: 'yearly' }));
  const hook = h.client({ origin: null });
  const event = (o: string, p: string, amount: number, type = 'payment.captured') => JSON.stringify({ event: type, payload: { payment: { entity: { id: p, order_id: o, amount, method: 'upi' } } } });
  const send = (raw: string, sig: string, id: string) => hook.raw('POST', '/webhooks/razorpay', raw, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': id });
  const raw2 = event(o2.orderId, 'pay_YEAR01', 799_000);
  const forged = await send(raw2, sign('wrong-secret', raw2), 'evt_1');
  check('forged signature → 400, logged as invalid, nothing paid', forged.status === 400 && (await WebhookEventModel.findOne({ eventId: 'evt_1' }).lean())?.signatureValid === false && (await sub()).planCode === 'monthly');
  const w2 = await send(raw2, sign(HOOK, raw2), 'evt_2');
  const s2 = await sub();
  check('signed payment.captured → Yearly, added after the running month (30 + 365 days)', w2.status === 200 && s2.planCode === 'yearly' && s2.maxUsers === 10 && near(s2.endDate, new Date(s1.endDate).getTime() + 365 * DAY), `${code(w2)} ${s2.endDate}`);
  check(`invoice MS-${fy}-00002 (one series across shops)`, (await SubscriptionPaymentModel.findOne({ razorpayOrderId: o2.orderId }).lean())?.invoiceNumber === `MS-${fy}-00002`);
  const dup = await send(raw2, sign(HOOK, raw2), 'evt_2');
  check('the same event again → duplicate, no extra year', dup.status === 200 && (dup.json.data as { result?: string } | undefined)?.result === 'duplicate' && (await sub()).endDate === s2.endDate);
  const o3 = data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' }));
  const raw3 = event(o3.orderId, 'pay_SHORT1', 100);
  const w3 = await send(raw3, sign(HOOK, raw3), 'evt_3');
  check('₹1 paid on a ₹799 order → not extended, payment failed', w3.status === 200 && (await SubscriptionPaymentModel.findOne({ razorpayOrderId: o3.orderId }).lean())?.status === 'failed' && (await sub()).endDate === s2.endDate);
  const o4 = data<Order>(await owner.post('/subscription/order', { planCode: 'monthly' }));
  const raw4 = event(o4.orderId, 'pay_FAIL01', 79_900, 'payment.failed');
  await send(raw4, sign(HOOK, raw4), 'evt_4');
  check('payment.failed → marked failed', (await SubscriptionPaymentModel.findOne({ razorpayOrderId: o4.orderId }).lean())?.status === 'failed');
  const raw4b = event(o4.orderId, 'pay_RETRY1', 79_900);
  const before4 = (await sub()).endDate;
  await send(raw4b, sign(HOOK, raw4b), 'evt_5');
  check('a retry on the same order that captures → paid, a month added', (await SubscriptionPaymentModel.findOne({ razorpayOrderId: o4.orderId }).lean())?.status === 'paid' && near((await sub()).endDate, new Date(before4).getTime() + 30 * DAY));

  section('4. History and invoice');
  const hist = data<Pay[]>(await owner.get('/subscription/payments'));
  check('history: 3 paid, 1 failed', hist.filter((x) => x.status === 'paid').length === 3 && hist.filter((x) => x.status === 'failed').length === 1);
  const paid = hist.find((x) => x.invoiceNumber === `MS-${fy}-00001`);
  const pdf = await owner.raw('GET', `/subscription/payments/${paid?.id ?? ''}/invoice`);
  check('invoice PDF', pdf.status === 200 && (pdf.headers.get('content-type') ?? '').includes('pdf'));
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
