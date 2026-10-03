import { createHash, randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { day, pdfTable, rupees } from '../../core/export';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { fyOf } from '../../utils/fy';
import { inr, rhu } from '../../utils/money';
import { stateCodeOf } from '../../utils/india';
import { checkPayment, checkWebhook, createOrder, fetchPayment, paymentSignature } from '../../services/razorpay';
import { ShopModel } from '../shops/shop.model';
import { audit } from '../audit/audit.model';
import { autopayEvent, autopayOf, disputeEvent, refundEvent, stopAutopay, type DisputeEntity, type PayEntity, type RefundEntity, type SubEntity } from './autopay';
import { MembershipModel } from '../memberships/membership.model';
import type { Actor } from '../user/actor';
import { DEFAULT_PLANS, PlanModel, PlatformCounterModel, SubscriptionPaymentModel, WebhookEventModel } from './billing.model';
import { SubscriptionModel, graceEndOf, statusAt } from './subscription.model';
import { priceFor } from './terms';

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (a: Date, b: Date) => Math.ceil((b.getTime() - a.getTime()) / DAY);

/** The buyable plans; a fresh database gets the placeholder list (PLAN §8). */
export async function plans() {
  if (!(await PlanModel.exists({}))) await PlanModel.insertMany(DEFAULT_PLANS, { ordered: false }).catch(() => undefined);
  const rows = await PlanModel.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
  return rows.map((p) => ({ code: p.code, name: p.name, price: p.price, durationDays: p.durationDays, maxUsers: p.maxUsers, perMonth: Math.round((p.price * 30) / p.durationDays) }));
}

interface PaymentRow { _id: Types.ObjectId; planName: string; amount: number; gst: number; status: string; razorpayOrderId: string; razorpayPaymentId?: string | null; periodStart?: Date | null; periodEnd?: Date | null; invoiceNumber?: string | null; source: string; createdAt?: Date; paidAt?: Date | null; failureReason?: string | null; refunded?: number; refunds?: { _id: Types.ObjectId; amount: number; status: string; creditNote?: string | null; daysRemoved: number; at: Date }[]; dispute?: { status?: string | null } | null }
export function shapePayment(p: PaymentRow) {
  return {
    id: String(p._id), planName: p.planName, amount: p.amount, gst: p.gst, status: p.status, orderId: p.razorpayOrderId, paymentId: p.razorpayPaymentId ?? null, periodStart: p.periodStart ?? null, periodEnd: p.periodEnd ?? null, invoiceNumber: p.invoiceNumber ?? null, source: p.source, createdAt: p.createdAt ?? null, paidAt: p.paidAt ?? null, failureReason: p.failureReason ?? null,
    refunded: p.refunded ?? 0,
    refunds: (p.refunds ?? []).map((r) => ({ id: String(r._id), amount: r.amount, status: r.status, creditNote: r.creditNote ?? null, daysRemoved: r.daysRemoved, at: r.at })),
    dispute: p.dispute?.status ?? null,
  };
}

/** The plans at this shop's own prices (PLAN §36.1) — the list price shows beside its own. */
export async function plansFor(shopId: Types.ObjectId, now = new Date()) {
  const list = await plans();
  return Promise.all(list.map(async (p) => {
    const f = await priceFor(shopId, p.code, p.price, now);
    return { ...p, price: f.price, listPrice: p.price, ownPrice: f.own, upcoming: f.upcoming, perMonth: Math.round((f.price * 30) / p.durationDays) };
  }));
}

export async function current(t: TenantContext, now = new Date()) {
  const [sub, list, users, last, autopay] = await Promise.all([
    SubscriptionModel.findOne({ shopId: t.shopId }).lean(),
    plansFor(t.shopId, now),
    MembershipModel.countDocuments({ shopId: t.shopId, status: { $in: ['active', 'invited'] } }),
    SubscriptionPaymentModel.findOne({ shopId: t.shopId, status: { $in: ['paid', 'failed'] } }).sort({ createdAt: -1 }).lean(),
    autopayOf(t.shopId),
  ]);
  if (!sub) throw AppError.notFound('No subscription');
  const status = statusAt(sub, now);
  return {
    status,
    planCode: sub.planCode,
    planName: sub.planCode === 'trial' ? 'Free trial' : (list.find((p) => p.code === sub.planCode)?.name ?? sub.planCode),
    startDate: sub.startDate,
    endDate: sub.endDate,
    graceEndDate: graceEndOf(sub.endDate),
    daysLeft: daysBetween(now, sub.endDate),
    maxUsers: sub.maxUsers,
    users,
    readOnly: status === 'expired' || status === 'cancelled',
    plans: list,
    lastPayment: last ? shapePayment(last) : null,
    autopay,
    payments: env.PAYMENTS_MODE,
    keyId: env.PAYMENTS_MODE === 'razorpay' ? (env.RAZORPAY_KEY_ID ?? null) : null,
  };
}

/** Step 1 of PLAN §8: an order at the plan's price, snapshotted with its 18% GST. */
export async function order(t: TenantContext, actor: Actor, planCode: string) {
  const plan = (await plansFor(t.shopId)).find((p) => p.code === planCode);
  if (!plan) throw AppError.validation('Choose a plan', [{ field: 'body.planCode', message: 'Choose a plan' }]);
  const receipt = `${String(t.shopId).slice(-8)}-${Date.now().toString(36)}`;
  const orderId = await createOrder(plan.price, receipt, { shopId: String(t.shopId), planCode: plan.code });
  const gst = plan.price - rhu(plan.price * 100, 118);
  await SubscriptionPaymentModel.create({ shopId: t.shopId, planCode: plan.code, planName: plan.name, durationDays: plan.durationDays, maxUsers: plan.maxUsers, amount: plan.price, gst, razorpayOrderId: orderId, status: 'created', source: env.PAYMENTS_MODE === 'test' ? 'test' : 'razorpay', createdBy: new Types.ObjectId(actor.id), createdByName: actor.name });
  return { orderId, amount: plan.price, currency: 'INR', planName: plan.name, keyId: env.PAYMENTS_MODE === 'razorpay' ? (env.RAZORPAY_KEY_ID ?? null) : null, mode: env.PAYMENTS_MODE, shopName: t.shopName };
}

/** Inside the payment's transaction, so a retried transaction never skips a number (consecutive per FY, ≤ 16 characters). */
async function nextInvoice(at: Date, session: ClientSession) {
  const fy = fyOf(at);
  const c = await PlatformCounterModel.findOneAndUpdate({ _id: `subInvoice:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session }).lean();
  return `MS-${fy}-${String(c.seq).padStart(5, '0')}`;
}

export interface Party { name?: string | null; address?: string | null; gstin?: string | null; state?: string | null; stateCode?: string | null }
export const supplier = (): Party => ({ name: env.BILLING_LEGAL_NAME, address: env.BILLING_ADDRESS, gstin: env.BILLING_GSTIN ?? '', state: env.BILLING_STATE, stateCode: stateCodeOf(env.BILLING_STATE) ?? '' });
export async function buyerOf(shopId: Types.ObjectId, session?: ClientSession): Promise<Party> {
  const s = await ShopModel.findById(shopId).select('legalName name address gstin').session(session ?? null).lean();
  const a = s?.address;
  if (!s || !a) return {};
  return { name: s.legalName || s.name, address: [a.line1, a.line2, a.city, `${a.state} ${a.pincode}`].filter(Boolean).join(', '), gstin: s.gstin ?? '', state: a.state, stateCode: a.stateCode };
}

/**
 * CGST Rule 46 rows for MedShop's invoice or credit note. Place of supply is the shop's state (IGST Act s.12(2)):
 * the same state as MedShop → CGST + SGST, another state → IGST.
 */
export function taxRows(gst: number, from: Party, to: Party): [string, string][] {
  const intra = Boolean(from.stateCode) && from.stateCode === to.stateCode;
  const cgst = Math.floor(gst / 2);
  return [
    ['Supplier', `${from.name ?? ''}, ${from.address ?? ''} · GSTIN ${from.gstin || '—'}`],
    ['Recipient', `${to.name ?? ''}, ${to.address ?? ''} · ${to.gstin ? `GSTIN ${to.gstin}` : 'Unregistered'}`],
    ['Place of supply', `${to.state ?? ''} (${to.stateCode ?? ''})`],
    ['SAC', env.BILLING_SAC],
    ...(intra ? ([['CGST 9%', rupees(cgst)], ['SGST 9%', rupees(gst - cgst)]] as [string, string][]) : ([['IGST 18%', rupees(gst)]] as [string, string][])),
    ['Tax on reverse charge', 'No'],
  ];
}
export const issuerOf = (from: Party) => ({ name: from.name ?? 'MedShop', line: [from.address, from.gstin ? `GSTIN ${from.gstin}` : ''].filter(Boolean).join(' · ') });

/**
 * The one place a payment turns into time on the plan — Checkout's verify and the webhook both land here, so it runs
 * once per order: a second call with the same payment is a no-op (PLAN §8 idempotent).
 */
export async function markPaid(orderId: string, paymentId: string, amount: number | null, method: string, by: { id: string; name: string } | null, now = new Date()) {
  // Outside the transaction: a throw inside it would roll the "failed" mark back too.
  const ordered = await SubscriptionPaymentModel.findOne({ razorpayOrderId: orderId }).select('amount status').lean();
  if (ordered && amount !== null && amount !== ordered.amount && ordered.status !== 'paid') {
    await SubscriptionPaymentModel.updateOne({ razorpayOrderId: orderId, status: { $ne: 'paid' } }, { $set: { status: 'failed', failureReason: `Amount ${inr(amount)} does not match ${inr(ordered.amount)}` } });
    throw AppError.conflict('The paid amount does not match the order', { reason: 'AMOUNT_MISMATCH' });
  }
  return inTransaction(async (session) => {
    const pay = await SubscriptionPaymentModel.findOne({ razorpayOrderId: orderId }).session(session);
    if (!pay) throw AppError.notFound('Payment not found');
    if (pay.status === 'paid') {
      if (pay.razorpayPaymentId !== paymentId) throw AppError.conflict('This order is already paid with another payment', { reason: 'ALREADY_PAID' });
      return { payment: pay, replayed: true };
    }
    // A failed attempt doesn't close the order: Razorpay lets the customer retry, and that capture counts.
    const sub = await SubscriptionModel.findOne({ shopId: pay.shopId }).session(session);
    if (!sub) throw AppError.internal();
    // A paid plan still running is extended from its end; a trial, grace or lapsed plan starts today.
    const start = sub.planCode !== 'trial' && statusAt(sub, now) === 'active' ? sub.endDate : now;
    const end = new Date(start.getTime() + pay.durationDays * DAY);
    const invoiceNumber = await nextInvoice(now, session);
    pay.set({ status: 'paid', razorpayPaymentId: paymentId, method, paidAt: now, periodStart: start, periodEnd: end, invoiceNumber, invoiceFrom: supplier(), invoiceTo: await buyerOf(pay.shopId, session), failureReason: undefined });
    await pay.save({ session });
    sub.set({ planCode: pay.planCode, status: 'active', endDate: end, graceEndDate: graceEndOf(end), maxUsers: pay.maxUsers, cancelledAt: undefined, cancelReason: undefined, ...(start === now ? { startDate: now } : {}) });
    await sub.save({ session });
    const who = by ?? { id: String(pay.createdBy), name: pay.createdByName };
    const text = pay.source === 'autopay' ? `Autopay charged ${inr(pay.amount)} for ${pay.planName}` : `${who.name} paid ${inr(pay.amount)} for ${pay.planName}`;
    await audit({ shopId: pay.shopId, userId: who.id, userName: who.name, action: 'update', module: 'subscription', entityId: String(pay._id), entityName: invoiceNumber, text: `${text} — valid till ${day(end)} (${invoiceNumber})`, ip: undefined }, session);
    return { payment: pay, replayed: false };
  });
}

/** B9 accounts desk: money taken outside Razorpay — the same extension and invoice through markPaid. */
export async function recordManual(shopId: Types.ObjectId, planCode: string, reference: string, by: { id: string; name: string }) {
  const plan = (await plansFor(shopId)).find((p) => p.code === planCode);
  if (!plan) throw AppError.validation('Choose a plan', [{ field: 'body.planCode', message: 'Choose a plan' }]);
  const id = `manual_${randomBytes(9).toString('hex')}`;
  await SubscriptionPaymentModel.create({ shopId, planCode: plan.code, planName: plan.name, durationDays: plan.durationDays, maxUsers: plan.maxUsers, amount: plan.price, gst: plan.price - rhu(plan.price * 100, 118), razorpayOrderId: id, status: 'created', source: 'manual', reference, createdBy: new Types.ObjectId(by.id), createdByName: by.name });
  const r = await markPaid(id, id, null, 'manual', by);
  return shapePayment(r.payment.toObject());
}

/** Step 2: Checkout hands back order, payment and signature; only a signature made with our secret counts. */
export async function verify(t: TenantContext, actor: Actor, input: { orderId: string; paymentId: string; signature: string }) {
  const pay = await SubscriptionPaymentModel.findOne({ shopId: t.shopId, razorpayOrderId: input.orderId }).lean();
  if (!pay) throw AppError.notFound('Payment not found');
  if (!checkPayment(input.orderId, input.paymentId, input.signature)) throw AppError.badRequest('The payment could not be verified', { reason: 'BAD_SIGNATURE' });
  // The signature is valid from authorisation on: time is given only for money Razorpay shows captured, at its amount.
  const g = await fetchPayment(input.paymentId);
  if (g && g.status !== 'captured') return { ...shapePayment(pay), replayed: false, confirming: true };
  const r = await markPaid(input.orderId, input.paymentId, g?.amount ?? null, g?.method ?? 'checkout', actor);
  return { ...shapePayment(r.payment.toObject()), replayed: r.replayed, confirming: false };
}

/** Test mode only: pays a test order the way Checkout would, with a real signature. Refused in production by config. */
export async function testPay(t: TenantContext, actor: Actor, orderId: string) {
  if (env.PAYMENTS_MODE !== 'test') throw AppError.forbidden('Test payments are off');
  const paymentId = `pay_test_${orderId.slice(-12)}`;
  return verify(t, actor, { orderId, paymentId, signature: paymentSignature(orderId, paymentId) });
}

interface Hook {
  event?: string;
  payload?: { payment?: { entity?: PayEntity }; subscription?: { entity?: SubEntity }; refund?: { entity?: RefundEntity }; dispute?: { entity?: DisputeEntity } };
}

/** Step 3: the webhook, in case the browser closed after paying. Signed, logged once per event id, then the same markPaid. */
export async function webhook(raw: string, signature: string, eventId: string) {
  const valid = checkWebhook(raw, signature);
  const payloadHash = createHash('sha256').update(raw).digest('hex');
  let body: Hook;
  try {
    body = JSON.parse(raw) as Hook;
  } catch {
    body = {};
  }
  const type = body.event ?? 'unknown';
  const id = eventId || `hash:${payloadHash}`;
  const record = async (result: string) => WebhookEventModel.create({ provider: 'razorpay', eventId: id, event: type, signatureValid: valid, result, payloadHash }).catch((err: unknown) => {
    if ((err as { code?: number }).code === 11000) return null;
    throw err;
  });
  if (!valid) {
    await record('rejected: bad signature');
    throw AppError.badRequest('Bad signature');
  }
  if (await WebhookEventModel.exists({ eventId: id })) return { result: 'duplicate' };
  const e = body.payload?.payment?.entity;
  let result = 'ignored';
  if (type.startsWith('subscription.')) {
    result = await autopayEvent(type, body.payload?.subscription?.entity, e);
  } else if (type.startsWith('refund.')) {
    result = await refundEvent(type, body.payload?.refund?.entity);
  } else if (type.startsWith('payment.dispute.')) {
    result = await disputeEvent(type, body.payload?.dispute?.entity);
  } else if ((type === 'payment.captured' || type === 'order.paid') && e?.order_id && e.id && !(await SubscriptionPaymentModel.exists({ razorpayOrderId: e.order_id }))) {
    // Autopay charges carry Razorpay's own order ids; they are paid through subscription.charged.
    result = 'ignored: not our order';
  } else if ((type === 'payment.captured' || type === 'order.paid') && e?.order_id && e.id) {
    const r = await markPaid(e.order_id, e.id, typeof e.amount === 'number' ? e.amount : null, e.method ?? 'razorpay', null).catch((err: unknown) => {
      if (err instanceof AppError) return { error: err.message };
      throw err;
    });
    result = 'error' in r ? `error: ${r.error}` : r.replayed ? 'already paid' : 'paid';
  } else if (type === 'payment.failed' && e?.order_id) {
    await SubscriptionPaymentModel.updateOne({ razorpayOrderId: e.order_id, status: 'created' }, { $set: { status: 'failed', failureReason: e.error_description ?? 'Payment failed' } });
    result = 'failed';
  }
  await record(result);
  return { result };
}

export async function payments(t: TenantContext) {
  const rows = await SubscriptionPaymentModel.find({ shopId: t.shopId, status: { $in: ['paid', 'failed'] } }).sort({ createdAt: -1 }).limit(100).lean();
  return rows.map(shapePayment);
}

/** A tax invoice for a paid plan (PLAN §8). MedShop's own GSTIN arrives with the platform settings (B9). */
export async function invoicePdf(t: TenantContext, id: string) {
  const p = await SubscriptionPaymentModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), status: 'paid' }).lean();
  if (!p?.invoiceNumber || !p.periodStart || !p.periodEnd) throw AppError.notFound('Invoice not found');
  const from = p.invoiceFrom ?? supplier();
  const to = p.invoiceTo ?? (await buyerOf(p.shopId));
  const [parties, tax] = [taxRows(p.gst, from, to).slice(0, 4), taxRows(p.gst, from, to).slice(4)];
  const rows: [string, string][] = [
    ...parties,
    ['Service', `MedShop software subscription — ${p.planName} · ${String(p.durationDays)} days · up to ${String(p.maxUsers)} users`],
    ['Period', `${day(p.periodStart)} – ${day(p.periodEnd)}`],
    ['Taxable value', rupees(p.amount - p.gst)],
    ...tax,
    ['Total', rupees(p.amount)],
    ['Payment', `${p.source === 'test' ? 'Test payment' : p.source === 'manual' ? `Paid outside Razorpay ${p.reference ?? ''}` : 'Razorpay'} ${p.razorpayPaymentId ?? ''}`.trim()],
  ];
  const buf = await pdfTable({ shopId: t.shopId, issuer: issuerOf(from), title: `Tax invoice ${p.invoiceNumber}`, sub: `Date ${day(p.paidAt ?? new Date())} · computer-generated`, columns: [{ label: 'Item', get: (r: [string, string]) => r[0], w: 1 }, { label: 'Detail', get: (r: [string, string]) => r[1], w: 2 }], rows });
  return { buf, name: p.invoiceNumber };
}

/** PLAN §8: cancelling makes the shop read-only at once — the data stays; paying again turns it back on. */
export async function cancel(t: TenantContext, actor: Actor, reason: string, ip?: string) {
  const sub = await SubscriptionModel.findOne({ shopId: t.shopId });
  if (!sub) throw AppError.notFound('No subscription');
  if (sub.status === 'cancelled') throw AppError.conflict('Already cancelled');
  await stopAutopay(t.shopId, actor, reason, ip);
  sub.set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason });
  await sub.save();
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'cancel', module: 'subscription', entityId: String(sub._id), entityName: 'Subscription', text: `${actor.name} cancelled the plan — ${reason}`, ip });
}
