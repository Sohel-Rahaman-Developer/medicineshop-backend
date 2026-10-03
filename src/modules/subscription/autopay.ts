import { randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { day, pdfTable, rupees } from '../../core/export';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { fyOf } from '../../utils/fy';
import { inr, rhu } from '../../utils/money';
import { cancelSubscription, checkSubscription, createPlan, createSubscription, fetchPayment, fetchRefunds, refundPayment, subscriptionSignature, type GwRefund } from '../../services/razorpay';
import { audit } from '../audit/audit.model';
import type { Actor } from '../user/actor';
import { AUTOPAY_STATUSES, AutopayModel, PlatformCounterModel, RzpPlanModel, SubscriptionPaymentModel, type AutopayStatus } from './billing.model';
import { SubscriptionModel, graceEndOf, statusAt } from './subscription.model';
import { buyerOf, issuerOf, markPaid, plansFor, supplier, taxRows } from './subscription.service';

const DAY = 24 * 60 * 60 * 1000;
/** These stop a second autopay; `created` (never approved) and `halted` (retries ran out) are replaced instead. */
const RUNNING: AutopayStatus[] = ['authenticated', 'active', 'pending', 'paused'];
const STOPPED: AutopayStatus[] = ['cancelled', 'completed'];
const MIN = 60 * 1000;
const isPending = (id: string) => id.startsWith('pending_');

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
  const shape = (id: string, startAt: Date | null) => ({ subscriptionId: id, amount: plan.price, planName: plan.name, startAt, keyId: env.PAYMENTS_MODE === 'razorpay' ? (env.RAZORPAY_KEY_ID ?? null) : null, mode: env.PAYMENTS_MODE, shopName: t.shopName });
  // Checkout closed and opened again: the same unapproved subscription, never a second mandate.
  const fresh = await AutopayModel.findOne({ shopId: t.shopId, status: 'created', planCode: plan.code, amount: plan.price, createdAt: { $gt: new Date(now.getTime() - 30 * MIN) } }).lean();
  if (fresh && !isPending(fresh.rzpSubscriptionId)) return shape(fresh.rzpSubscriptionId, fresh.startAt ?? null);
  for (const old of await AutopayModel.find({ shopId: t.shopId, status: { $in: ['created', 'halted'] } }).lean()) {
    // Another request is creating this one right now; a reservation older than 2 minutes died with its request.
    if (isPending(old.rzpSubscriptionId) && (old as { createdAt?: Date }).createdAt && (old as { createdAt: Date }).createdAt > new Date(now.getTime() - 2 * MIN)) continue;
    if (!isPending(old.rzpSubscriptionId)) await cancelSubscription(old.rzpSubscriptionId).catch(() => undefined);
    await AutopayModel.updateOne({ _id: old._id, status: old.status }, { $set: { status: 'cancelled', stoppedAt: now, stopReason: 'Replaced by a new autopay' }, $unset: { live: 1 } });
  }
  const startAt = sub.planCode !== 'trial' && statusAt(sub, now) === 'active' ? sub.endDate : null;
  const rzpPlanId = await rzpPlanFor(plan.code, plan.name, plan.price);
  // Reserved before Razorpay is called: a second request at the same moment meets the unique index, not a second mandate.
  const a = await AutopayModel.create({ shopId: t.shopId, planCode: plan.code, planName: plan.name, amount: plan.price, durationDays: plan.durationDays, maxUsers: plan.maxUsers, rzpSubscriptionId: `pending_${randomBytes(9).toString('hex')}`, rzpPlanId, status: 'created', live: true, ...(startAt ? { startAt } : {}), createdBy: new Types.ObjectId(actor.id), createdByName: actor.name }).catch((err: unknown) => {
    if ((err as { code?: number }).code === 11000) throw AppError.conflict('Autopay is already being set up — finish it in the open window', { reason: 'AUTOPAY_ON' });
    throw err;
  });
  let id: string;
  try {
    id = await createSubscription(rzpPlanId, plan.code === 'yearly' ? 10 : 120, startAt, { shopId: String(t.shopId), planCode: plan.code });
  } catch (err) {
    a.set({ status: 'cancelled', live: undefined, stoppedAt: now, stopReason: 'Razorpay did not create it' });
    await a.save();
    throw err;
  }
  a.set({ rzpSubscriptionId: id });
  await a.save();
  return shape(id, startAt);
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
  if (STOPPED.includes(a.status)) {
    // Replaced or stopped while its Checkout was open: the approval must not leave a live mandate behind.
    await cancelSubscription(a.rzpSubscriptionId).catch(() => undefined);
  } else if (a.status === 'created') {
    a.set({ status: 'authenticated' });
    await a.save();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'subscription', entityId: String(a._id), entityName: 'Autopay', text: `${actor.name} turned on autopay — ${a.planName} ${inr(a.amount)}${a.startAt ? `, first charge ${day(a.startAt)}` : ''}`, ip: undefined });
  }
  // No start date: the approval payment is the first charge — booked now only if Razorpay shows it captured, otherwise
  // subscription.charged or the hourly reconcile books it.
  if (!a.startAt) {
    const g = await fetchPayment(input.paymentId);
    if (!g || g.status === 'captured') await charge(a.rzpSubscriptionId, input.paymentId, g?.amount ?? null, g?.method ?? 'autopay', actor, null, now);
  }
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
  a.set({ status: 'cancelled', live: undefined, stoppedAt: now, stopReason: reason });
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
  a.set({ ...(keep ? {} : { status: next }), ...(chargeAt ? { chargeAt } : {}), ...(STOPPED.includes(next) ? { live: undefined } : {}), ...(STOPPED.includes(next) && !a.stoppedAt ? { stoppedAt: now, stopReason: `Razorpay: ${next}` } : {}) });
  await a.save();
  if (!keep && (next === 'pending' || next === 'halted')) {
    await audit({ shopId: a.shopId, userId: String(a.createdBy), userName: 'MedShop', action: 'update', module: 'subscription', entityId: String(a._id), entityName: 'Autopay', text: next === 'pending' ? 'Autopay payment failed — Razorpay will try again' : 'Autopay stopped after failed payments — pay once or turn autopay on again', ip: undefined });
  }
  return next;
}

/** CGST Rule 53 / 46(b): consecutive per FY, at most 16 characters — CN-2026-27-00001. */
async function nextCreditNote(at: Date, session: ClientSession) {
  const fy = fyOf(at);
  const c = await PlatformCounterModel.findOneAndUpdate({ _id: `subCredit:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session }).lean();
  return `CN-${fy}-${String(c.seq).padStart(5, '0')}`;
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
 * B8c admin refund: reserved in a transaction (two clicks can't refund past the amount), sent to Razorpay with our refund id
 * as its receipt (a repeat can never refund twice), then settled. A manual payment's refund is only recorded.
 */
export async function refund(paymentDocId: string, input: { amount: number; removeDays: boolean; reason: string }, by: { id: string; name: string }, now = new Date()) {
  const held = await inTransaction(async (session) => {
    const p = await SubscriptionPaymentModel.findById(paymentDocId).session(session);
    if (p?.status !== 'paid') throw AppError.notFound('Paid payment not found');
    const left = p.amount - p.refunded;
    if (input.amount < 100 || input.amount > left) throw AppError.validation(`Refund between ₹1 and ${inr(left)}`, [{ field: 'body.amount', message: `At most ${inr(left)}` }]);
    p.refunds.push({ amount: input.amount, status: 'pending', reason: input.reason, removeDays: input.removeDays, byName: by.name, at: now, daysRemoved: 0 });
    p.refunded += input.amount;
    await p.save({ session });
    const r = p.refunds[p.refunds.length - 1];
    if (!r) throw AppError.internal();
    return { receipt: String(r._id), source: p.source, rzpPaymentId: p.razorpayPaymentId ?? '' };
  });
  let gw: GwRefund;
  if (held.source === 'manual') gw = { id: `manual_refund_${randomBytes(6).toString('hex')}`, status: 'processed' };
  else {
    try {
      gw = await refundPayment(held.rzpPaymentId, input.amount, { reason: input.reason.slice(0, 200) }, held.receipt);
    } catch (err) {
      // "Duplicate receipt" means Razorpay already made it: settle that one instead of failing.
      const made = (await fetchRefunds(held.rzpPaymentId).catch(() => [])).find((x) => x.receipt === held.receipt);
      if (!made) {
        await settleRefund(paymentDocId, held.receipt, { id: '', status: 'failed' }, now);
        throw err;
      }
      gw = made;
    }
  }
  const s = await settleRefund(paymentDocId, held.receipt, gw, now);
  if (s.status === 'failed') throw AppError.conflict('Razorpay refused the refund', { reason: 'REFUND_FAILED' });
  return { shopId: s.shopId, amount: input.amount, creditNote: s.creditNote, invoiceNumber: s.invoiceNumber, days: s.days, status: s.status, full: s.full };
}

/**
 * The one place a refund gets its Razorpay id, credit note and plan days — once, whichever of the request, a webhook or
 * the hourly reconcile gets there first. `settled` says whether this call did it.
 */
export async function settleRefund(paymentDocId: Types.ObjectId | string, refundId: string, gw: GwRefund, now = new Date()) {
  return inTransaction(async (session) => {
    const p = await SubscriptionPaymentModel.findById(paymentDocId).session(session);
    const r = p?.refunds.find((x) => String(x._id) === refundId);
    if (!p || !r) throw AppError.internal();
    const base = { shopId: p.shopId, invoiceNumber: p.invoiceNumber ?? '', amount: r.amount };
    if (r.creditNote || r.status === 'failed') return { ...base, settled: false, status: r.status, creditNote: r.creditNote ?? '', days: r.daysRemoved, full: p.refunded >= p.amount };
    if (gw.status === 'failed') {
      r.set({ ...(gw.id ? { rzpRefundId: gw.id } : {}), status: 'failed' });
      p.refunded -= r.amount;
      await p.save({ session });
      return { ...base, settled: true, status: 'failed' as const, creditNote: '', days: 0, full: false };
    }
    const full = p.refunded >= p.amount;
    const days = full || r.removeDays ? Math.max(0, p.durationDays - daysTaken(p)) : 0;
    r.set({ rzpRefundId: gw.id, status: gw.status, creditNote: await nextCreditNote(now, session), daysRemoved: days });
    await p.save({ session });
    await shiftEnd(p.shopId, -days, session);
    return { ...base, settled: true, status: gw.status, creditNote: r.creditNote ?? '', days, full };
  });
}

/** Shop log line for a refund settled by a webhook or the reconcile (the admin's own refund is logged by the admin service). */
export async function auditSettled(s: { shopId: Types.ObjectId; settled: boolean; status: string; amount: number; creditNote: string; days: number }) {
  if (!s.settled) return;
  await audit({ shopId: s.shopId, userId: String(s.shopId), userName: 'MedShop', action: 'update', module: 'subscription', entityId: String(s.shopId), entityName: s.creditNote || 'Refund', text: s.status === 'failed' ? `Refund of ${inr(s.amount)} did not go through — nothing was refunded` : `Refund of ${inr(s.amount)} confirmed by Razorpay — credit note ${s.creditNote}${s.days ? `, ${String(s.days)} plan days removed` : ''}`, ip: undefined });
}

export interface RefundEntity { id?: string; payment_id?: string; amount?: number; status?: string; receipt?: string | null }

/** refund.* webhooks: settles a refund our own save missed (by its receipt); a later failure puts the money count and days back. */
export async function refundEvent(type: string, e: RefundEntity | undefined, now = new Date()): Promise<string> {
  if (!e?.id) return 'ignored';
  const id = e.id;
  if (e.receipt && Types.ObjectId.isValid(e.receipt) && !(await SubscriptionPaymentModel.exists({ 'refunds.rzpRefundId': id }))) {
    const owner = await SubscriptionPaymentModel.findOne({ 'refunds._id': new Types.ObjectId(e.receipt) }).select('_id').lean();
    if (owner) {
      const s = await settleRefund(owner._id, e.receipt, { id, status: type === 'refund.failed' ? 'failed' : type === 'refund.processed' ? 'processed' : 'pending' }, now);
      await auditSettled(s);
      if (s.settled) return `refund settled (${s.status})`;
    }
  }
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

/** A GST credit note for one refund (CGST Rule 53) — against the original invoice, which stays as it was. */
export async function creditNotePdf(t: TenantContext, paymentId: string, refundId: string) {
  const p = await SubscriptionPaymentModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(paymentId) }).lean();
  const r = p?.refunds.find((x) => String(x._id) === refundId);
  if (!p || !r?.creditNote || r.status === 'failed') throw AppError.notFound('Credit note not found');
  const gst = r.amount - rhu(r.amount * 100, 118);
  const from = p.invoiceFrom ?? supplier();
  const to = p.invoiceTo ?? (await buyerOf(p.shopId));
  const lines = taxRows(gst, from, to);
  const rows: [string, string][] = [
    ...lines.slice(0, 4),
    ['Against invoice', `${p.invoiceNumber ?? ''} dated ${p.paidAt ? day(p.paidAt) : ''}`],
    ['Service', `MedShop software subscription — ${p.planName}`],
    ['Taxable value', rupees(r.amount - gst)],
    ...lines.slice(4),
    ['Total refunded', rupees(r.amount)],
    ['Plan days removed', String(r.daysRemoved)],
    ['Reason', r.reason],
  ];
  const buf = await pdfTable({ shopId: t.shopId, issuer: issuerOf(from), title: `Credit note ${r.creditNote}`, sub: `Date ${day(r.at)} · computer-generated`, columns: [{ label: 'Item', get: (x: [string, string]) => x[0], w: 1 }, { label: 'Detail', get: (x: [string, string]) => x[1], w: 2 }], rows });
  return { buf, name: r.creditNote };
}
