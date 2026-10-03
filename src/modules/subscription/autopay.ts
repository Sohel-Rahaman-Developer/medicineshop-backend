import { randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { day, pdfTable, rupees } from '../../core/export';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { fyOf } from '../../utils/fy';
import { inr, rhu } from '../../utils/money';
import { cancelSubscription, checkSubscription, createPlan, createSubscription, refundPayment, subscriptionSignature } from '../../services/razorpay';
import { audit } from '../audit/audit.model';
import type { Actor } from '../user/actor';
import { AUTOPAY_STATUSES, AutopayModel, PlatformCounterModel, RzpPlanModel, SubscriptionPaymentModel, type AutopayStatus } from './billing.model';
import { SubscriptionModel, graceEndOf, statusAt } from './subscription.model';
import { markPaid, plansFor } from './subscription.service';

const DAY = 24 * 60 * 60 * 1000;
/** These stop a second autopay; `created` (never approved) and `halted` (retries ran out) are replaced instead. */
const RUNNING: AutopayStatus[] = ['authenticated', 'active', 'pending', 'paused'];
const STOPPED: AutopayStatus[] = ['cancelled', 'completed'];

async function rzpPlanFor(code: string, name: string, amount: number) {
  const key = `${env.PAYMENTS_MODE}:${code}:${String(amount)}`;
  const have = await RzpPlanModel.findById(key).lean();
  if (have) return have.rzpPlanId;
  const id = await createPlan(code === 'yearly' ? 'yearly' : 'monthly', amount, `MedShop ${name}`);
  await RzpPlanModel.updateOne({ _id: key }, { $setOnInsert: { rzpPlanId: id } }, { upsert: true });
  return (await RzpPlanModel.findById(key).lean())?.rzpPlanId ?? id;
}

/** The shop's autopay as the Plan screen shows it — the latest one, running or not. */
export async function autopayOf(shopId: Types.ObjectId) {
  const a = await AutopayModel.findOne({ shopId, status: { $ne: 'created' } }).sort({ createdAt: -1 }).lean();
  if (!a) return null;
  return { status: a.status, planCode: a.planCode, planName: a.planName, amount: a.amount, startAt: a.startAt ?? null, chargeAt: a.chargeAt ?? null, paidCount: a.paidCount, stoppedAt: a.stoppedAt ?? null, running: RUNNING.includes(a.status) };
}

/**
 * B8c: a Razorpay subscription for the plan at the shop's price. A paid plan still running is first charged on its end
 * date; a trial or lapsed plan is charged when the owner approves.
 */
export async function startAutopay(t: TenantContext, actor: Actor, planCode: string, now = new Date()) {
  const plan = (await plansFor(t.shopId, now)).find((p) => p.code === planCode);
  if (!plan) throw AppError.validation('Choose a plan', [{ field: 'body.planCode', message: 'Choose a plan' }]);
  if (await AutopayModel.exists({ shopId: t.shopId, status: { $in: RUNNING } })) throw AppError.conflict('Autopay is already on — stop it first to change the plan', { reason: 'AUTOPAY_ON' });
  const sub = await SubscriptionModel.findOne({ shopId: t.shopId }).lean();
  if (!sub) throw AppError.notFound('No subscription');
  for (const old of await AutopayModel.find({ shopId: t.shopId, status: { $in: ['created', 'halted'] } })) {
    await cancelSubscription(old.rzpSubscriptionId).catch(() => undefined);
    old.set({ status: 'cancelled', stoppedAt: now, stopReason: 'Replaced by a new autopay' });
    await old.save();
  }
  const startAt = sub.planCode !== 'trial' && statusAt(sub, now) === 'active' ? sub.endDate : null;
  const rzpPlanId = await rzpPlanFor(plan.code, plan.name, plan.price);
  const id = await createSubscription(rzpPlanId, plan.code === 'yearly' ? 10 : 120, startAt, { shopId: String(t.shopId), planCode: plan.code });
  await AutopayModel.create({ shopId: t.shopId, planCode: plan.code, planName: plan.name, amount: plan.price, durationDays: plan.durationDays, maxUsers: plan.maxUsers, rzpSubscriptionId: id, rzpPlanId, status: 'created', ...(startAt ? { startAt } : {}), createdBy: new Types.ObjectId(actor.id), createdByName: actor.name });
  return { subscriptionId: id, amount: plan.price, planName: plan.name, startAt, keyId: env.PAYMENTS_MODE === 'razorpay' ? (env.RAZORPAY_KEY_ID ?? null) : null, mode: env.PAYMENTS_MODE, shopName: t.shopName };
}

/**
 * Each charge becomes a payment through markPaid — the same invoice and plan extension as a one-time payment, once per
 * Razorpay payment id however often Checkout and the webhooks report it.
 */
export async function charge(subscriptionId: string, paymentId: string, amount: number | null, method: string, by: { id: string; name: string } | null, chargeAt: Date | null, now = new Date()) {
  const a = await AutopayModel.findOne({ rzpSubscriptionId: subscriptionId }).lean();
  if (!a) throw AppError.notFound('Autopay not found');
  const key = `autopay_${paymentId}`;
  await SubscriptionPaymentModel.updateOne(
    { razorpayOrderId: key },
    { $setOnInsert: { shopId: a.shopId, planCode: a.planCode, planName: a.planName, durationDays: a.durationDays, maxUsers: a.maxUsers, amount: a.amount, gst: a.amount - rhu(a.amount * 100, 118), razorpayOrderId: key, status: 'created', source: 'autopay', autopayId: subscriptionId, createdBy: a.createdBy, createdByName: a.createdByName } },
    { upsert: true },
  );
  const r = await markPaid(key, paymentId, amount, method, by, now);
  if (!r.replayed) {
    await AutopayModel.updateOne({ _id: a._id }, { $inc: { paidCount: 1 }, ...(chargeAt ? { $set: { chargeAt } } : {}) });
    await AutopayModel.updateOne({ _id: a._id, status: { $nin: STOPPED } }, { $set: { status: 'active' } });
  }
  return r;
}

/** Checkout hands back payment, subscription and signature once the owner approves the mandate. */
export async function verifyAutopay(t: TenantContext, actor: Actor, input: { subscriptionId: string; paymentId: string; signature: string }, now = new Date()) {
  const a = await AutopayModel.findOne({ shopId: t.shopId, rzpSubscriptionId: input.subscriptionId });
  if (!a) throw AppError.notFound('Autopay not found');
  if (!checkSubscription(input.paymentId, input.subscriptionId, input.signature)) throw AppError.badRequest('The approval could not be verified', { reason: 'BAD_SIGNATURE' });
  if (a.status === 'created') {
    a.set({ status: 'authenticated' });
    await a.save();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'subscription', entityId: String(a._id), entityName: 'Autopay', text: `${actor.name} turned on autopay — ${a.planName} ${inr(a.amount)}${a.startAt ? `, first charge ${day(a.startAt)}` : ''}`, ip: undefined });
  }
  // No start date: the approval payment is the first charge.
  if (!a.startAt) await charge(a.rzpSubscriptionId, input.paymentId, null, 'autopay', actor, null, now);
  return autopayOf(t.shopId);
}

/** Test mode only: approves the mandate the way Checkout would, with a real signature. */
export async function testApprove(t: TenantContext, actor: Actor, subscriptionId: string) {
  if (env.PAYMENTS_MODE !== 'test') throw AppError.forbidden('Test payments are off');
  const paymentId = `pay_test_${subscriptionId.slice(-12)}`;
  return verifyAutopay(t, actor, { subscriptionId, paymentId, signature: subscriptionSignature(paymentId, subscriptionId) });
}

/** The owner (or MedShop) stops autopay: Razorpay cancels the mandate first, so nothing is charged after we say stopped. */
export async function stopAutopay(shopId: Types.ObjectId, by: { id: string; name: string }, reason: string, ip?: string, now = new Date()) {
  const a = await AutopayModel.findOne({ shopId, status: { $nin: STOPPED } }).sort({ createdAt: -1 });
  if (!a) return false;
  await cancelSubscription(a.rzpSubscriptionId);
  a.set({ status: 'cancelled', stoppedAt: now, stopReason: reason });
  await a.save();
  await audit({ shopId, userId: by.id, userName: by.name, action: 'update', module: 'subscription', entityId: String(a._id), entityName: 'Autopay', text: `${by.name} stopped autopay — ${reason}. The plan runs to its end date.`, ip });
  return true;
}

const EVENT_STATUS: Record<string, AutopayStatus> = {
  'subscription.authenticated': 'authenticated',
  'subscription.activated': 'active',
  'subscription.resumed': 'active',
  'subscription.pending': 'pending',
  'subscription.halted': 'halted',
  'subscription.paused': 'paused',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed',
};

export interface SubEntity { id?: string; status?: string; charge_at?: number }
export interface PayEntity { id?: string; order_id?: string; amount?: number; method?: string; error_description?: string }

/** subscription.* webhooks: a charge pays; the rest move the status (never a stopped autopay back to life). */
export async function autopayEvent(type: string, s: SubEntity | undefined, p: PayEntity | undefined, now = new Date()): Promise<string> {
  if (!s?.id) return 'ignored';
  const a = await AutopayModel.findOne({ rzpSubscriptionId: s.id });
  if (!a) return 'ignored: unknown subscription';
  const chargeAt = typeof s.charge_at === 'number' ? new Date(s.charge_at * 1000) : null;
  if (type === 'subscription.charged') {
    if (!p?.id) return 'error: no payment';
    const r = await charge(s.id, p.id, typeof p.amount === 'number' ? p.amount : null, p.method ?? 'autopay', null, chargeAt, now).catch((err: unknown) => {
      if (err instanceof AppError) return { error: err.message };
      throw err;
    });
    return 'error' in r ? `error: ${r.error}` : r.replayed ? 'already paid' : 'charged';
  }
  const fromEntity = AUTOPAY_STATUSES.find((x) => x === s.status);
  const next = EVENT_STATUS[type] ?? fromEntity;
  if (!next) return 'ignored';
  if (STOPPED.includes(a.status) && !STOPPED.includes(next)) return 'ignored: stopped';
  // Events can arrive out of order: a late "authenticated" never moves an autopay that already ran.
  const keep = next === 'authenticated' && a.status !== 'created';
  a.set({ ...(keep ? {} : { status: next }), ...(chargeAt ? { chargeAt } : {}), ...(STOPPED.includes(next) && !a.stoppedAt ? { stoppedAt: now, stopReason: `Razorpay: ${next}` } : {}) });
  await a.save();
  if (!keep && (next === 'pending' || next === 'halted')) {
    await audit({ shopId: a.shopId, userId: String(a.createdBy), userName: 'MedShop', action: 'update', module: 'subscription', entityId: String(a._id), entityName: 'Autopay', text: next === 'pending' ? 'Autopay payment failed — Razorpay will try again' : 'Autopay stopped after failed payments — pay once or turn autopay on again', ip: undefined });
  }
  return next;
}

async function nextCreditNote(at: Date) {
  const fy = fyOf(at);
  const c = await PlatformCounterModel.findOneAndUpdate({ _id: `subCredit:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  return `MSCN-${fy}-${String(c.seq).padStart(5, '0')}`;
}

/** Moves the plan's end date; refunds take days off, a failed refund gives them back. */
async function shiftEnd(shopId: Types.ObjectId, days: number, session: ClientSession) {
  if (days === 0) return;
  const sub = await SubscriptionModel.findOne({ shopId }).session(session);
  if (!sub) return;
  const end = new Date(sub.endDate.getTime() + days * DAY);
  sub.set({ endDate: end, graceEndDate: graceEndOf(end) });
  await sub.save({ session });
}

interface DaysTaken { refunds: { status: string; daysRemoved: number }[]; dispute?: { daysRemoved?: number | null } | null }
const daysTaken = (p: DaysTaken) => p.refunds.filter((r) => r.status !== 'failed').reduce((s, r) => s + r.daysRemoved, 0) + (p.dispute?.daysRemoved ?? 0);

/**
 * B8c admin refund: reserved in a transaction (two clicks can't refund past the amount), sent to Razorpay, then the
 * credit note and — for a full refund or when asked — the plan days. A manual payment's refund is only recorded.
 */
export async function refund(paymentDocId: string, input: { amount: number; removeDays: boolean; reason: string }, by: { id: string; name: string }, now = new Date()) {
  const held = await inTransaction(async (session) => {
    const p = await SubscriptionPaymentModel.findById(paymentDocId).session(session);
    if (p?.status !== 'paid') throw AppError.notFound('Paid payment not found');
    const left = p.amount - p.refunded;
    if (input.amount < 100 || input.amount > left) throw AppError.validation(`Refund between ₹1 and ${inr(left)}`, [{ field: 'body.amount', message: `At most ${inr(left)}` }]);
    p.refunds.push({ amount: input.amount, status: 'pending', reason: input.reason, byName: by.name, at: now, daysRemoved: 0 });
    p.refunded += input.amount;
    await p.save({ session });
    const r = p.refunds[p.refunds.length - 1];
    if (!r) throw AppError.internal();
    return { refundId: r._id, source: p.source, rzpPaymentId: p.razorpayPaymentId ?? '' };
  });
  let gw: { id: string; status: 'pending' | 'processed' | 'failed' };
  try {
    gw = held.source === 'manual' ? { id: `manual_refund_${randomBytes(6).toString('hex')}`, status: 'processed' } : await refundPayment(held.rzpPaymentId, input.amount, { reason: input.reason.slice(0, 200) });
  } catch (err) {
    await SubscriptionPaymentModel.updateOne({ _id: paymentDocId, 'refunds._id': held.refundId }, { $set: { 'refunds.$.status': 'failed' }, $inc: { refunded: -input.amount } });
    throw err;
  }
  return inTransaction(async (session) => {
    const p = await SubscriptionPaymentModel.findById(paymentDocId).session(session);
    const r = p?.refunds.find((x) => String(x._id) === String(held.refundId));
    if (!p || !r) throw AppError.internal();
    if (gw.status === 'failed') {
      r.set({ rzpRefundId: gw.id, status: 'failed' });
      p.refunded -= input.amount;
      await p.save({ session });
      throw AppError.conflict('Razorpay refused the refund', { reason: 'REFUND_FAILED' });
    }
    const full = p.refunded >= p.amount;
    const days = full || input.removeDays ? Math.max(0, p.durationDays - daysTaken(p)) : 0;
    r.set({ rzpRefundId: gw.id, status: gw.status, creditNote: await nextCreditNote(now), daysRemoved: days });
    await p.save({ session });
    await shiftEnd(p.shopId, -days, session);
    return { shopId: p.shopId, amount: input.amount, creditNote: r.creditNote ?? '', invoiceNumber: p.invoiceNumber ?? '', days, status: gw.status, full };
  });
}

export interface RefundEntity { id?: string; payment_id?: string; amount?: number; status?: string }

/** refund.processed / refund.failed: a failed refund puts the money count and the plan days back. */
export async function refundEvent(type: string, e: RefundEntity | undefined): Promise<string> {
  if (!e?.id) return 'ignored';
  const id = e.id;
  return inTransaction(async (session) => {
    const p = await SubscriptionPaymentModel.findOne({ 'refunds.rzpRefundId': id }).session(session);
    const r = p?.refunds.find((x) => x.rzpRefundId === id);
    if (!p || !r) return 'ignored: unknown refund';
    if (type === 'refund.processed' && r.status === 'pending') {
      r.set({ status: 'processed' });
      await p.save({ session });
      return 'refund processed';
    }
    if (type === 'refund.failed' && r.status !== 'failed') {
      const days = r.daysRemoved;
      r.set({ status: 'failed', daysRemoved: 0 });
      p.refunded -= r.amount;
      await p.save({ session });
      await shiftEnd(p.shopId, days, session);
      await audit({ shopId: p.shopId, userId: String(p.createdBy), userName: 'MedShop', action: 'update', module: 'subscription', entityId: String(p._id), entityName: r.creditNote ?? 'Refund', text: `Refund of ${inr(r.amount)} failed at the bank${days ? ` — ${String(days)} plan days given back` : ''}`, ip: undefined }, session);
      return 'refund failed';
    }
    return 'no change';
  });
}

export interface DisputeEntity { id?: string; payment_id?: string; amount?: number; status?: string; reason_code?: string }
const DISPUTE_STATUS: Record<string, string> = { 'payment.dispute.created': 'open', 'payment.dispute.action_required': 'open', 'payment.dispute.under_review': 'review', 'payment.dispute.won': 'won', 'payment.dispute.lost': 'lost', 'payment.dispute.closed': 'closed' };

/** payment.dispute.*: recorded on the payment; lost → the plan days that payment bought go (once). */
export async function disputeEvent(type: string, e: DisputeEntity | undefined, now = new Date()): Promise<string> {
  const status = DISPUTE_STATUS[type];
  if (!status || !e?.payment_id) return 'ignored';
  const paymentId = e.payment_id;
  return inTransaction(async (session) => {
    const p = await SubscriptionPaymentModel.findOne({ razorpayPaymentId: paymentId }).session(session);
    if (!p) return 'ignored: unknown payment';
    const before = p.dispute?.daysRemoved ?? 0;
    const days = status === 'lost' ? Math.max(0, p.durationDays - daysTaken(p)) : 0;
    p.set({ dispute: { id: e.id ?? p.dispute?.id ?? '', status, amount: e.amount ?? p.dispute?.amount ?? p.amount, reason: e.reason_code ?? p.dispute?.reason ?? '', at: now, daysRemoved: before + days } });
    await p.save({ session });
    await shiftEnd(p.shopId, -days, session);
    await audit({ shopId: p.shopId, userId: String(p.createdBy), userName: 'MedShop', action: 'update', module: 'subscription', entityId: String(p._id), entityName: p.invoiceNumber ?? 'Payment', text: `Card dispute ${status} on ${p.invoiceNumber ?? 'a payment'}${days ? ` — ${String(days)} plan days removed` : ''}`, ip: undefined }, session);
    return `dispute ${status}`;
  });
}

/** A GST credit note for one refund (B8c) — the invoice it reverses stays as it was. */
export async function creditNotePdf(t: TenantContext, paymentId: string, refundId: string) {
  const p = await SubscriptionPaymentModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(paymentId) }).lean();
  const r = p?.refunds.find((x) => String(x._id) === refundId);
  if (!p || !r?.creditNote || r.status === 'failed') throw AppError.notFound('Credit note not found');
  const gst = r.amount - rhu(r.amount * 100, 118);
  const rows: [string, string][] = [
    ['Against invoice', p.invoiceNumber ?? ''],
    ['Plan', p.planName],
    ['Taxable value', rupees(r.amount - gst)],
    ['GST 18%', rupees(gst)],
    ['Total refunded', rupees(r.amount)],
    ['Plan days removed', String(r.daysRemoved)],
    ['Reason', r.reason],
  ];
  const buf = await pdfTable({ shopId: t.shopId, title: `Credit note ${r.creditNote}`, sub: `MedShop subscription · ${day(r.at)}`, columns: [{ label: 'Item', get: (x: [string, string]) => x[0], w: 1 }, { label: 'Detail', get: (x: [string, string]) => x[1], w: 2 }], rows });
  return { buf, name: r.creditNote };
}
