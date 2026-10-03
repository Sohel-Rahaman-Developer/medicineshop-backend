// B8c checks: autopay (Razorpay Subscriptions), each charge once, refunds with credit notes, disputes.
import { createHmac } from 'node:crypto';
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

interface Autopay { status: string; planCode: string; amount: number; startAt: string | null; paidCount: number; running: boolean }
interface Sub { status: string; planCode: string; endDate: string; autopay: Autopay | null }
interface Pay { id: string; status: string; source: string; invoiceNumber: string | null; refunded: number; refunds: { id: string; amount: number; status: string; creditNote: string | null; daysRemoved: number }[]; dispute: string | null; paymentId: string | null }
interface Start { subscriptionId: string; amount: number; startAt: string | null; mode: string }

const DAY = 86_400_000;
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
const KEY = 'smoke-razorpay-key-secret';
const HOOK = 'smoke-razorpay-webhook-secret';
const near = (a: string | Date, b: number) => Math.abs(new Date(a).getTime() - b) < 60_000;

async function main() {
  const h = await startHarness();
  const { SubscriptionPaymentModel, AutopayModel, WebhookEventModel } = await import('../src/modules/subscription/billing.model.js');
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { totpAt } = await import('../src/utils/totp.js');

  const owner = await h.signIn('rohit@auto1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'vikram@auto1.test', name: 'Vikram', roleId: roles.find((r) => r.key === 'manager')?.id });
  const manager = await h.signIn('vikram@auto1.test');
  await manager.post(`/invitations/${data<{ id: string }[]>(await manager.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Vikram' });
  manager.shopId = shopId;
  const sub = async () => data<Sub>(await owner.get('/subscription'));
  const pays = async () => data<Pay[]>(await owner.get('/subscription/payments'));
  const hook = h.client({ origin: null });
  let n = 0;
  const send = (body: unknown, id = `evt_a${String(++n)}`) => {
    const raw = JSON.stringify(body);
    return hook.raw('POST', '/webhooks/razorpay', raw, { 'x-razorpay-signature': sign(HOOK, raw), 'x-razorpay-event-id': id });
  };
  const subEvent = (event: string, subscriptionId: string, payment?: { id: string; amount: number }) => ({ event, payload: { subscription: { entity: { id: subscriptionId, status: event.split('.')[1] } }, ...(payment ? { payment: { entity: { ...payment, method: 'upi', order_id: `order_rzp_${payment.id}` } } } : {}) } });
  const result = async (id: string) => (await WebhookEventModel.findOne({ eventId: id }).lean())?.result;

  section('1. Turn on autopay from a trial: the approval is the first charge');
  const a0 = await owner.post('/subscription/autopay', { planCode: 'monthly' });
  const s0 = data<Start>(a0);
  check('owner starts Monthly autopay → a subscription, first charge now', a0.status === 201 && s0.subscriptionId.startsWith('sub_test_') && s0.startAt === null && s0.amount === 79_900, code(a0));
  check('not approved yet → the Plan screen shows no autopay', (await sub()).autopay === null);
  check('manager can’t turn it on → 403', (await manager.post('/subscription/autopay', { planCode: 'monthly' })).status === 403);
  const s1 = data<Start>(await owner.post('/subscription/autopay', { planCode: 'monthly' }));
  check('trying again replaces the unapproved one', (await AutopayModel.findOne({ rzpSubscriptionId: s0.subscriptionId }).lean())?.status === 'cancelled' && s1.subscriptionId !== s0.subscriptionId);
  const bad = await owner.post('/subscription/autopay/verify', { subscriptionId: s1.subscriptionId, paymentId: 'pay_X1', signature: 'a'.repeat(64) });
  check('a made-up signature → 400 BAD_SIGNATURE, still trial', bad.status === 400 && reason(bad) === 'BAD_SIGNATURE' && (await sub()).status === 'trial', code(bad));
  const pay1 = 'pay_AUTO0001';
  const ok = await owner.post('/subscription/autopay/verify', { subscriptionId: s1.subscriptionId, paymentId: pay1, signature: sign(KEY, `${pay1}|${s1.subscriptionId}`) });
  const v1 = await sub();
  check('signed approval → active Monthly, 30 days, autopay active (1 charge)', ok.status === 200 && v1.status === 'active' && v1.planCode === 'monthly' && near(v1.endDate, Date.now() + 30 * DAY) && v1.autopay?.status === 'active' && v1.autopay.paidCount === 1, `${code(ok)} ${JSON.stringify(v1)}`);
  const p1 = (await pays())[0];
  check('the charge is an autopay payment with its own tax invoice', p1?.source === 'autopay' && /^MS-/.test(p1.invoiceNumber ?? ''), JSON.stringify(p1));
  check('shop log: who turned autopay on', Boolean(await AuditLogModel.exists({ shopId, text: { $regex: 'turned on autopay' } })));
  const conflict = await owner.post('/subscription/autopay', { planCode: 'yearly' });
  check('a second autopay while one runs → 409 AUTOPAY_ON', conflict.status === 409 && reason(conflict) === 'AUTOPAY_ON', code(conflict));

  section('2. Renewals arrive by webhook, once each');
  const end1 = new Date(v1.endDate).getTime();
  const e1 = 'evt_charge_2';
  const c2 = await send(subEvent('subscription.charged', s1.subscriptionId, { id: 'pay_AUTO0002', amount: 79_900 }), e1);
  const v2 = await sub();
  check('subscription.charged → 30 more days after the running month', c2.status === 200 && near(v2.endDate, end1 + 30 * DAY) && v2.autopay?.paidCount === 2 && (await result(e1)) === 'charged', `${code(c2)} ${v2.endDate}`);
  await send(subEvent('subscription.charged', s1.subscriptionId, { id: 'pay_AUTO0002', amount: 79_900 }), e1);
  const again = 'evt_charge_2b';
  await send(subEvent('subscription.charged', s1.subscriptionId, { id: 'pay_AUTO0002', amount: 79_900 }), again);
  check('same event again, or the same payment under a new event → no extra days', (await sub()).endDate === v2.endDate && (await result(again)) === 'already paid' && (await SubscriptionPaymentModel.countDocuments({ shopId, source: 'autopay', status: 'paid' })) === 2);
  const wrong = 'evt_charge_bad';
  await send(subEvent('subscription.charged', s1.subscriptionId, { id: 'pay_AUTO0003', amount: 100 }), wrong);
  check('a charge for the wrong amount → refused, no days', (await sub()).endDate === v2.endDate && ((await result(wrong)) ?? '').startsWith('error'), await result(wrong));
  const cap = 'evt_cap_other';
  await send({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_AUTO0002', order_id: 'order_rzp_pay_AUTO0002', amount: 79_900, method: 'upi' } } } }, cap);
  check('payment.captured for the charge (Razorpay’s own order) → ignored, not an error', (await result(cap)) === 'ignored: not our order');

  section('3. Failures and the order of events');
  const pend = 'evt_pending';
  await send(subEvent('subscription.pending', s1.subscriptionId), pend);
  check('subscription.pending → pending, the shop log says Razorpay will retry', (await sub()).autopay?.status === 'pending' && Boolean(await AuditLogModel.exists({ shopId, text: { $regex: 'Razorpay will try again' } })));
  await send(subEvent('subscription.authenticated', s1.subscriptionId));
  check('a late "authenticated" doesn’t move it back', (await sub()).autopay?.status === 'pending');
  await send(subEvent('subscription.halted', s1.subscriptionId));
  check('subscription.halted → halted (no longer running)', (await sub()).autopay?.status === 'halted' && (await sub()).autopay?.running === false);
  const y = await owner.post('/subscription/autopay', { planCode: 'yearly' });
  const sy = data<Start>(y);
  check('after halted a new autopay is allowed; plan running → first charge on its end date', y.status === 201 && near(sy.startAt ?? 0, new Date(v2.endDate).getTime()) && (await AutopayModel.findOne({ rzpSubscriptionId: s1.subscriptionId }).lean())?.status === 'cancelled', code(y));
  const payY = 'pay_AUTH_Y1';
  await owner.post('/subscription/autopay/verify', { subscriptionId: sy.subscriptionId, paymentId: payY, signature: sign(KEY, `${payY}|${sy.subscriptionId}`) });
  const v3 = await sub();
  check('approving a later start charges nothing now (the plan end stays)', v3.autopay?.status === 'authenticated' && v3.autopay.planCode === 'yearly' && v3.endDate === v2.endDate && (await SubscriptionPaymentModel.countDocuments({ shopId, source: 'autopay', status: 'paid' })) === 2);
  await send(subEvent('subscription.activated', sy.subscriptionId));
  check('subscription.activated → active', (await sub()).autopay?.status === 'active');

  section('4. Stopping autopay');
  check('manager can’t stop it → 403', (await manager.post('/subscription/autopay/stop', { reason: 'Testing' })).status === 403);
  const st = await owner.post('/subscription/autopay/stop', { reason: 'Paying by cash now' });
  const v4 = await sub();
  check('owner stops it → stopped, the plan keeps its end date', st.status === 200 && v4.autopay?.status === 'cancelled' && v4.endDate === v2.endDate && v4.status === 'active', code(st));
  const late = 'evt_late_active';
  await send(subEvent('subscription.activated', sy.subscriptionId), late);
  check('a late event never turns a stopped autopay back on', (await sub()).autopay?.status === 'cancelled' && (await result(late)) === 'ignored: stopped');
  check('stop again → 409', (await owner.post('/subscription/autopay/stop', { reason: 'Again please' })).status === 409);

  section('5. Refunds (admin) — credit note, plan days');
  await AdminUserModel.create({ email: 'acc@medshop.test', name: 'Accounts', role: 'accounts' });
  await AdminUserModel.create({ email: 'help@medshop.test', name: 'Helpdesk', role: 'support' });
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const s = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' })).secret ?? '';
    await c.post('/admin/auth/totp', { code: totpAt(s, Math.floor(Date.now() / 30_000)) });
    return c;
  };
  const acc = await login('acc@medshop.test');
  const help = await login('help@medshop.test');
  const [second, first] = (await pays()).filter((p) => p.source === 'autopay' && p.status === 'paid');
  if (!first || !second) throw new Error('no autopay payments');
  check('support can’t refund → 403', (await help.post(`/admin/payments/${first.id}/refund`, { amount: 10_000, removeDays: false, reason: 'Customer asked' })).status === 403);
  check('no reason → 422', (await acc.post(`/admin/payments/${first.id}/refund`, { amount: 10_000, removeDays: false, reason: '' })).status === 422);
  const endBefore = (await sub()).endDate;
  const r1 = await acc.post(`/admin/payments/${first.id}/refund`, { amount: 10_000, removeDays: false, reason: 'Charged a day early' });
  const f1 = (await pays()).find((p) => p.id === first.id);
  check('partial ₹100 → processed, credit note MSCN-, plan days unchanged', r1.status === 200 && f1?.refunded === 10_000 && f1.refunds[0]?.status === 'processed' && /^MSCN-/.test(f1.refunds[0].creditNote ?? '') && (await sub()).endDate === endBefore, code(r1));
  const over = await acc.post(`/admin/payments/${first.id}/refund`, { amount: 70_000, removeDays: false, reason: 'Too much money' });
  check('more than what is left (₹699) → 422', over.status === 422, code(over));
  const r2 = await acc.post(`/admin/payments/${first.id}/refund`, { amount: 69_900, removeDays: false, reason: 'Shop closed down' });
  const f2 = (await pays()).find((p) => p.id === first.id);
  check('the rest → fully refunded: 30 plan days come off, second credit note', r2.status === 200 && f2?.refunded === 79_900 && f2.refunds[1]?.daysRemoved === 30 && near((await sub()).endDate, new Date(endBefore).getTime() - 30 * DAY) && f2.refunds[1].creditNote !== f2.refunds[0]?.creditNote, code(r2));
  const cn = await owner.raw('GET', `/subscription/payments/${first.id}/credit-notes/${f2?.refunds[0]?.id ?? ''}`);
  check('owner downloads the credit note (PDF)', cn.status === 200 && (cn.headers.get('content-type') ?? '').includes('pdf'), String(cn.status));
  check('admin log and the shop’s log both record the refund', Boolean(await AdminAuditModel.exists({ action: 'refund', reason: 'Shop closed down' })) && Boolean(await AuditLogModel.exists({ shopId, text: { $regex: 'refunded ₹699' } })));
  const [x, y2] = await Promise.all([1, 2].map(() => acc.post(`/admin/payments/${second.id}/refund`, { amount: 79_900, removeDays: false, reason: 'Two clicks at once' })));
  const f3 = (await pays()).find((p) => p.id === second.id);
  check('two refunds of the full amount at once → one goes through', [x?.status, y2?.status].filter((s) => s === 200).length === 1 && f3?.refunded === 79_900 && f3.refunds.filter((r) => r.status !== 'failed').length === 1, `${String(x?.status)} ${String(y2?.status)}`);

  section('6. A refund the bank fails, and disputes');
  const endF = (await sub()).endDate;
  const rf = (await SubscriptionPaymentModel.findById(second.id).lean())?.refunds.find((r) => r.status !== 'failed');
  await send({ event: 'refund.failed', payload: { refund: { entity: { id: rf?.rzpRefundId, payment_id: 'pay_AUTO0002', amount: 79_900, status: 'failed' } } } });
  const f4 = (await pays()).find((p) => p.id === second.id);
  check('refund.failed → the money count and the 30 days come back', f4?.refunded === 0 && near((await sub()).endDate, new Date(endF).getTime() + 30 * DAY), `${String(f4?.refunded)} ${(await sub()).endDate}`);
  await send({ event: 'refund.failed', payload: { refund: { entity: { id: rf?.rzpRefundId } } } });
  check('the same failure twice → no double days, the money count stays right', (await pays()).find((p) => p.id === second.id)?.refunded === 0 && near((await sub()).endDate, new Date(endF).getTime() + 30 * DAY));
  const endD = (await sub()).endDate;
  await send({ event: 'payment.dispute.created', payload: { dispute: { entity: { id: 'disp_1', payment_id: 'pay_AUTO0002', amount: 79_900, reason_code: 'fraud' } } } });
  check('dispute opened → recorded, days unchanged', (await pays()).find((p) => p.id === second.id)?.dispute === 'open' && (await sub()).endDate === endD);
  await send({ event: 'payment.dispute.lost', payload: { dispute: { entity: { id: 'disp_1', payment_id: 'pay_AUTO0002' } } } });
  await send({ event: 'payment.dispute.lost', payload: { dispute: { entity: { id: 'disp_1', payment_id: 'pay_AUTO0002' } } } });
  check('dispute lost → its 30 days come off, once', (await pays()).find((p) => p.id === second.id)?.dispute === 'lost' && near((await sub()).endDate, new Date(endD).getTime() - 30 * DAY));

  section('7. Cancelling the plan stops autopay');
  const s7 = data<Start>(await owner.post('/subscription/autopay', { planCode: 'monthly' }));
  const p7 = 'pay_AUTH_M7';
  await owner.post('/subscription/autopay/verify', { subscriptionId: s7.subscriptionId, paymentId: p7, signature: sign(KEY, `${p7}|${s7.subscriptionId}`) });
  check('autopay on again', (await sub()).autopay?.running === true);
  await owner.post('/subscription/cancel', { reason: 'Closing the shop' });
  const v7 = await sub();
  check('cancel plan → read-only and autopay stopped', v7.status === 'cancelled' && v7.autopay?.status === 'cancelled');

  finish();
}

main().catch(crash);
