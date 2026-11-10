import { createHash, randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import { day, rupees } from '../../core/export';
import { invoicePdf as invoiceDoc } from '../../core/invoice-pdf';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { fyOf } from '../../utils/fy';
import { inr, rhu } from '../../utils/money';
import { rupeesInWords } from '../../utils/words';
import { checkPayment, checkWebhook, createOrder, fetchPayment, paymentSignature } from '../../services/razorpay';
import { signal } from '../../services/monitor';
import { ShopModel } from '../shops/shop.model';
import { platform } from '../admin/platform';
import { audit } from '../audit/audit.model';
import { autopayEvent, autopayOf, disputeEvent, refundEvent, stopAutopay, type DisputeEntity, type PayEntity, type RefundEntity, type SubEntity } from './autopay';
import { MembershipModel } from '../memberships/membership.model';
import type { Actor } from '../user/actor';
import { PlanModel, PlatformCounterModel, SubscriptionPaymentModel, WebhookEventModel } from './billing.model';
import { billingInfo, gateway } from './gateway';
import { SubscriptionModel, graceEndOf, planAt, statusAt, type PlanState } from './subscription.model';
import { priceFor } from './terms';
import { allFeatures, type Tier } from './features';
import { packageOfPlan, packages, type Package } from './plan-access';
import { logger } from '../../config/logger';
import { chargeRow, onlineCharge, splitOf, type Charge } from './online-charge';
export { forgetTiers } from './plan-access';
import { afterPaid, discountFor, withOffer, type Offer } from '../referral/referral.service';

const DAY = 24 * 60 * 60 * 1000;
// Loaded when used: the coins module builds its invoices from this one.
const coins = () => import('../ai/coins.js');
const addressPay = () => import('../webaddress/web-address-pay.js');
const daysBetween = (a: Date, b: Date) => Math.ceil((b.getTime() - a.getTime()) / DAY);

/** 30 days → 1, 365 → 12: a yearly ₹2,388 is ₹199 a month. */
export const monthsOf = (days: number) => Math.max(1, Math.round(days / 30.4));
interface PlanRow { code: string; name: string; price: number; basePrice?: number | null; durationDays: number; isActive: boolean; tier: string }
// D113: features and users come from the plan's package; the plan carries the price and the period.
const shapePlan = (p: PlanRow, packs: Map<Tier, Package>) => {
  const pack = packs.get(p.tier as Tier);
  const basePrice = p.basePrice ?? rhu(p.price * 100, 118);
  return { code: p.code, name: p.name, price: p.price, basePrice, durationDays: p.durationDays, months: monthsOf(p.durationDays), maxUsers: pack?.maxUsers ?? 1, perMonth: Math.round(p.price / monthsOf(p.durationDays)), basePerMonth: Math.round(basePrice / monthsOf(p.durationDays)), tier: p.tier as Tier, features: pack?.features ?? allFeatures(), isActive: p.isActive };
};

/** The buyable plans; a fresh database gets the list prices (PLAN §8, D113). */
export async function plans() {
  const packs = await packages();
  const rows = await PlanModel.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
  return rows.map((p) => shapePlan(p, packs));
}

/** Every plan, on sale or not, for the admin's editor. */
export async function allPlans() {
  const packs = await packages();
  return (await PlanModel.find({}).sort({ isActive: -1, sortOrder: 1 }).lean()).map((p) => shapePlan(p, packs));
}

/** D113: the two packages with their plans, for the admin's editor and the website. */
export async function packageList(o: { onSale?: boolean } = {}) {
  const [packs, list] = await Promise.all([packages(), o.onSale ? plans() : allPlans()]);
  return { packages: [...packs.values()], plans: list };
}

interface PaymentRow { _id: Types.ObjectId; kind?: string | null; upgrade?: { fromName: string; days: number } | null; planName: string; amount: number; gst: number; status: string; razorpayOrderId: string; razorpayPaymentId?: string | null; periodStart?: Date | null; periodEnd?: Date | null; invoiceNumber?: string | null; source: string; createdAt?: Date; paidAt?: Date | null; failureReason?: string | null; refunded?: number; refunds?: { _id: Types.ObjectId; amount: number; status: string; creditNote?: string | null; daysRemoved: number; at: Date }[]; dispute?: { status?: string | null } | null; discount?: { kind: string; pct: number; off: number; listAmount: number } | null; charge?: Charge | null }
export function shapePayment(p: PaymentRow) {
  return {
    id: String(p._id), kind: p.kind === 'upgrade' ? ('upgrade' as const) : ('plan' as const), upgradeFrom: p.upgrade?.fromName ?? null, planName: p.planName, amount: p.amount, gst: p.gst, status: p.status, orderId: p.razorpayOrderId, paymentId: p.razorpayPaymentId ?? null, periodStart: p.periodStart ?? null, periodEnd: p.periodEnd ?? null, invoiceNumber: p.invoiceNumber ?? null, source: p.source, createdAt: p.createdAt ?? null, paidAt: p.paidAt ?? null, failureReason: p.failureReason ?? null,
    refunded: p.refunded ?? 0,
    refunds: (p.refunds ?? []).map((r) => ({ id: String(r._id), amount: r.amount, status: r.status, creditNote: r.creditNote ?? null, daysRemoved: r.daysRemoved, at: r.at })),
    dispute: p.dispute?.status ?? null,
    discount: p.discount ? { kind: p.discount.kind, pct: p.discount.pct, off: p.discount.off, listAmount: p.discount.listAmount } : null,
    charge: splitOf(p.amount, p.charge).charge,
  };
}

/** The plans at this shop's own prices (PLAN §36.1) — the list price shows beside its own. */
export async function plansFor(shopId: Types.ObjectId, now = new Date()) {
  const list = await plans();
  return Promise.all(list.map(async (p) => {
    const f = await priceFor(shopId, p.code, p.price, now);
    // A shop's own price is GST-inclusive like the list price; its base is worked back for the "+ GST" line.
    const basePrice = f.own || f.price !== p.price ? rhu(f.price * 100, 118) : p.basePrice;
    return { ...p, price: f.price, basePrice, listPrice: p.price, ownPrice: f.own, upcoming: f.upcoming, perMonth: Math.round(f.price / p.months), basePerMonth: Math.round(basePrice / p.months) };
  }));
}

const planName = async (code: string) => (code === 'trial' ? 'Free trial' : code === 'demo' ? 'Demo shop · free for life' : ((await PlanModel.findOne({ code }).select('name').lean())?.name ?? code));

/**
 * D113: Basic → Pro now, for the days already paid — the Pro price per day less the Basic price per day, at this shop's
 * prices, times the days left (₹1 at least). Only a running Basic plan with nothing paid after it.
 */
export async function upgradeQuote(shopId: Types.ObjectId, sub: PlanState & { status: 'trial' | 'active' | 'grace' | 'expired' | 'cancelled'; endDate: Date }, now = new Date()) {
  const p = planAt(sub, now);
  if (p.next || statusAt({ ...sub, planCode: p.planCode }, now) !== 'active') return null;
  const cur = await PlanModel.findOne({ code: p.planCode }).lean();
  if (cur?.tier !== 'basic') return null;
  const days = daysBetween(now, sub.endDate);
  if (days < 1) return null;
  const yearly = cur.durationDays >= 365;
  const pro = (await plansFor(shopId, now)).filter((x) => x.tier === 'pro' && x.durationDays >= 365 === yearly).sort((a, b) => Math.abs(a.durationDays - cur.durationDays) - Math.abs(b.durationDays - cur.durationDays))[0];
  if (!pro) return null;
  const curPrice = (await priceFor(shopId, cur.code, cur.price, now)).price;
  const price = Math.max(100, Math.round((pro.price / pro.durationDays - curPrice / cur.durationDays) * days));
  return { planCode: pro.code, planName: pro.name, days, price, until: sub.endDate, from: { code: cur.code, name: cur.name, price: curPrice, durationDays: cur.durationDays, maxUsers: p.maxUsers }, to: { price: pro.price, durationDays: pro.durationDays } };
}

/** D113: one plan at a time — a plan paid for next, or a running autopay, decides what can be bought now. */
export async function canBuy(shopId: Types.ObjectId, planCode: string, now = new Date()) {
  const [sub, auto] = await Promise.all([SubscriptionModel.findOne({ shopId }).lean(), autopayOf(shopId)]);
  const next = sub ? planAt(sub, now).next : null;
  if (next && next.planCode !== planCode) throw AppError.conflict(`${await planName(next.planCode)} is already paid for from ${day(next.from)} — pay for that plan to add more days`, { reason: 'NEXT_PLAN' });
  if (auto?.running && auto.planCode !== planCode) throw AppError.conflict(`Autopay is on for ${auto.planName} — stop it first to change the plan`, { reason: 'AUTOPAY_ON' });
}

export async function current(t: TenantContext, now = new Date()) {
  const g = await gateway();
  const [sub, list, users, last, autopay, offer] = await Promise.all([
    SubscriptionModel.findOne({ shopId: t.shopId }).lean(),
    plansFor(t.shopId, now),
    MembershipModel.countDocuments({ shopId: t.shopId, status: { $in: ['active', 'invited'] } }),
    SubscriptionPaymentModel.findOne({ shopId: t.shopId, status: { $in: ['paid', 'failed'] } }).sort({ createdAt: -1 }).lean(),
    autopayOf(t.shopId),
    discountFor(t.shopId, now),
  ]);
  if (!sub) throw AppError.notFound('No subscription');
  const status = statusAt(sub, now);
  const p = planAt(sub, now);
  const upgrade = t.demo ? null : await upgradeQuote(t.shopId, sub, now);
  const upPay = upgrade ? await onlineCharge(upgrade.price) : null;
  return {
    status,
    planCode: p.planCode,
    planName: await planName(p.planCode),
    tier: p.planCode === 'trial' || p.planCode === 'demo' ? null : ((await packageOfPlan(p.planCode, now.getTime()))?.tier ?? null),
    demo: t.demo,
    startDate: sub.startDate,
    endDate: sub.endDate,
    graceEndDate: graceEndOf(sub.endDate),
    daysLeft: daysBetween(now, sub.endDate),
    maxUsers: t.subscription.maxUsers,
    users,
    next: p.next ? { planCode: p.next.planCode, planName: await planName(p.next.planCode), from: p.next.from, until: p.next.until } : null,
    upgrade: upgrade && upPay ? { ...upgrade, ...splitOf(upPay.amount, upPay.charge) } : null,
    readOnly: status === 'expired' || status === 'cancelled',
    plans: list.map((p) => ({ ...p, pay: withOffer(p.price, offer).amount })),
    offer: offer ? { kind: offer.kind, pct: offer.pct, until: offer.until } : null,
    lastPayment: last ? shapePayment(last) : null,
    autopay,
    payments: g.mode,
    keyId: g.mode === 'razorpay' ? g.keyId : null,
    chargePct: g.chargeBps / 100,
  };
}

/** Step 1 of PLAN §8: an order at the plan's price, snapshotted with its 18% GST. */
export async function order(t: TenantContext, actor: Actor, planCode: string) {
  const g = await gateway();
  const plan = (await plansFor(t.shopId)).find((p) => p.code === planCode);
  if (!plan) throw AppError.validation('Choose a plan', [{ field: 'body.planCode', message: 'Choose a plan' }]);
  await canBuy(t.shopId, plan.code);
  const offer = await discountFor(t.shopId);
  const { amount: price, off } = withOffer(plan.price, offer);
  // The referral discount first, then the online payment charge on what is left.
  const { amount, gst, charge } = await onlineCharge(price);
  const receipt = `${String(t.shopId).slice(-8)}-${Date.now().toString(36)}`;
  const orderId = await createOrder(amount, receipt, { shopId: String(t.shopId), planCode: plan.code });
  await SubscriptionPaymentModel.create({ shopId: t.shopId, planCode: plan.code, planName: plan.name, durationDays: plan.durationDays, maxUsers: plan.maxUsers, amount, gst, charge, discount: discountRecord(offer, off, plan.price), razorpayOrderId: orderId, status: 'created', source: g.mode === 'test' ? 'test' : 'razorpay', createdBy: new Types.ObjectId(actor.id), createdByName: actor.name });
  return { orderId, ...splitOf(amount, charge), currency: 'INR', planName: plan.name, keyId: g.mode === 'razorpay' ? g.keyId : null, mode: g.mode, shopName: t.shopName };
}

/** D113: an order for Basic → Pro over the days left; paid through the same verify / webhook as any order. */
export async function upgradeOrder(t: TenantContext, actor: Actor, now = new Date()) {
  const g = await gateway();
  const sub = await SubscriptionModel.findOne({ shopId: t.shopId }).lean();
  const q = sub ? await upgradeQuote(t.shopId, sub, now) : null;
  if (!q) throw AppError.conflict('Upgrading is for a running Basic plan', { reason: 'NO_UPGRADE' });
  const pack = await packageOfPlan(q.planCode, now.getTime());
  const { amount, gst, charge } = await onlineCharge(q.price);
  const receipt = `${String(t.shopId).slice(-8)}-${Date.now().toString(36)}`;
  const orderId = await createOrder(amount, receipt, { shopId: String(t.shopId), planCode: q.planCode, kind: 'upgrade' });
  await SubscriptionPaymentModel.create({ shopId: t.shopId, kind: 'upgrade', upgrade: { fromPlanCode: q.from.code, fromName: q.from.name, fromMaxUsers: q.from.maxUsers, days: q.days }, planCode: q.planCode, planName: q.planName, durationDays: q.days, maxUsers: pack?.maxUsers ?? q.from.maxUsers, amount, gst, charge, razorpayOrderId: orderId, status: 'created', source: g.mode === 'test' ? 'test' : 'razorpay', createdBy: new Types.ObjectId(actor.id), createdByName: actor.name });
  return { orderId, ...splitOf(amount, charge), currency: 'INR', planName: `${q.from.name} → ${q.planName}`, keyId: g.mode === 'razorpay' ? g.keyId : null, mode: g.mode, shopName: t.shopName };
}

const discountRecord = (o: Offer | null, off: number, listAmount: number) => (o && off ? { kind: o.kind, pct: o.pct, off, listAmount, referralId: o.referralId } : undefined);

/** Inside the payment's transaction, so a retried transaction never skips a number (consecutive per FY, ≤ 16 characters). */
export async function nextInvoice(at: Date, session: ClientSession) {
  const fy = fyOf(at);
  const c = await PlatformCounterModel.findOneAndUpdate({ _id: `subInvoice:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session }).lean();
  return `MS-${fy}-${String(c.seq).padStart(5, '0')}`;
}

export interface Party { name?: string | null; address?: string | null; gstin?: string | null; state?: string | null; stateCode?: string | null }
export async function supplier(): Promise<Party> {
  const b = await billingInfo();
  return { name: b.legalName, address: b.address, gstin: b.gstin, state: b.state, stateCode: b.stateCode };
}
export async function buyerOf(shopId: Types.ObjectId, session?: ClientSession): Promise<Party> {
  const s = await ShopModel.findById(shopId).select('legalName name address gstin').session(session ?? null).lean();
  const a = s?.address;
  if (!s || !a) return {};
  return { name: s.legalName || s.name, address: [a.line1, a.line2, a.city, `${a.state} ${a.pincode}`].filter(Boolean).join(', '), gstin: s.gstin ?? '', state: a.state, stateCode: a.stateCode };
}

/** CGST Rule 46: place of supply is the shop's state (IGST Act s.12(2)) — MedBox24's own state → CGST + SGST, else IGST. */
export function gstLines(gst: number, from: Party, to: Party) {
  const intra = Boolean(from.stateCode) && from.stateCode === to.stateCode;
  const cgst = Math.floor(gst / 2);
  return intra ? [{ label: 'CGST 9%', value: rupees(cgst) }, { label: 'SGST 9%', value: rupees(gst - cgst) }] : [{ label: 'IGST 18%', value: rupees(gst) }];
}
export const placeOf = (to: Party) => `${to.state ?? ''} (${to.stateCode ?? ''})`;
export const issuerOf = (from: Party, email: string) => ({ name: from.name ?? 'MedBox24', lines: [from.address ?? '', [`GSTIN ${from.gstin || '—'}`, email].filter(Boolean).join(' · ')].filter(Boolean) });
export const billedTo = (to: Party) => ({ label: 'Billed to', lines: [to.name ?? '', to.address ?? '', to.gstin ? `GSTIN ${to.gstin}` : 'Unregistered'] });
export const SUB_COLUMNS = [{ label: '#', w: 0.4 }, { label: 'Description', w: 4 }, { label: 'SAC', w: 1, num: true }, { label: 'Taxable', w: 1.2, num: true }, { label: 'GST', w: 0.7, num: true }, { label: 'Amount', w: 1.2, num: true }];

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
  const r = await inTransaction(async (session) => {
    const pay = await SubscriptionPaymentModel.findOne({ razorpayOrderId: orderId }).session(session);
    if (!pay) throw AppError.notFound('Payment not found');
    if (pay.status === 'paid') {
      if (pay.razorpayPaymentId !== paymentId) throw AppError.conflict('This order is already paid with another payment', { reason: 'ALREADY_PAID' });
      return { payment: pay, replayed: true };
    }
    // A failed attempt doesn't close the order: Razorpay lets the customer retry, and that capture counts.
    const sub = await SubscriptionModel.findOne({ shopId: pay.shopId }).session(session);
    if (!sub) throw AppError.internal();
    const was = planAt(sub, now);
    if (was.rolled) sub.set({ planCode: was.planCode, maxUsers: was.maxUsers, kept: was.kept, next: undefined });
    // D113: what the package opens now is what this payment bought, to the end of its period.
    const features = (await packageOfPlan(pay.planCode, now.getTime()))?.features ?? allFeatures();
    const invoiceNumber = await nextInvoice(now, session);
    const paid = { status: 'paid', razorpayPaymentId: paymentId, method, paidAt: now, features, invoiceNumber, invoiceFrom: await supplier(), invoiceTo: await buyerOf(pay.shopId, session), failureReason: undefined };
    let end: Date;
    if (pay.kind === 'upgrade') {
      // Basic → Pro at once, to the end already paid for.
      end = sub.endDate > now ? sub.endDate : now;
      pay.set({ ...paid, periodStart: now, periodEnd: end, continued: true });
      sub.set({ planCode: pay.planCode, maxUsers: pay.maxUsers, kept: { features, until: end } });
    } else {
      // A paid plan still running is extended from its end; a trial, grace or lapsed plan starts today.
      const running = sub.planCode !== 'trial' && statusAt(sub, now) === 'active';
      const start = running ? sub.endDate : now;
      end = new Date(start.getTime() + pay.durationDays * DAY);
      pay.set({ ...paid, periodStart: start, periodEnd: end, continued: running });
      const after = sub.next?.planCode ?? sub.planCode;
      if (!running) sub.set({ planCode: pay.planCode, maxUsers: pay.maxUsers, kept: { features, until: end }, next: undefined, startDate: now });
      else if (pay.planCode !== after) sub.set({ next: { planCode: pay.planCode, from: sub.next?.from ?? start, until: end, maxUsers: pay.maxUsers, features } });
      else if (sub.next) sub.set({ next: { planCode: sub.next.planCode, from: sub.next.from, until: end, maxUsers: pay.maxUsers, features } });
      else sub.set({ maxUsers: pay.maxUsers, kept: { features, until: end } });
      sub.set({ status: 'active', endDate: end, graceEndDate: graceEndOf(end), cancelledAt: undefined, cancelReason: undefined });
    }
    await pay.save({ session });
    await sub.save({ session });
    await afterPaid(pay, now, session);
    const who = by ?? { id: String(pay.createdBy), name: pay.createdByName };
    const what = pay.kind === 'upgrade' ? `${pay.upgrade?.fromName ?? 'Basic'} → ${pay.planName} for ${String(pay.durationDays)} days` : pay.planName;
    const text = pay.source === 'autopay' ? `Autopay charged ${inr(pay.amount)} for ${what}` : `${who.name} paid ${inr(pay.amount)} for ${what}`;
    const from = sub.next ? ` — ${pay.planName} from ${day(sub.next.from)}` : '';
    await audit({ shopId: pay.shopId, userId: who.id, userName: who.name, action: 'update', module: 'subscription', entityId: String(pay._id), entityName: invoiceNumber, text: `${text}${from} — valid till ${day(end)} (${invoiceNumber})`, ip: undefined }, session);
    return { payment: pay, replayed: false };
  });
  // The Basic autopay must not charge again after Pro is paid; the owner turns autopay on for Pro.
  if (!r.replayed && r.payment.kind === 'upgrade') {
    const who = by ?? { id: String(r.payment.createdBy), name: r.payment.createdByName };
    await stopAutopay(r.payment.shopId, who, `Upgraded to ${r.payment.planName} — autopay was for ${r.payment.upgrade?.fromName ?? 'Basic'}`).catch(async (err: unknown) => {
      logger.error({ err, shopId: String(r.payment.shopId) }, 'Basic autopay did not stop after an upgrade');
      await signal('autopay_stop_fail', now);
    });
  }
  return r;
}

/** B9 accounts desk: money taken outside Razorpay — the same extension and invoice through markPaid. */
export async function recordManual(shopId: Types.ObjectId, planCode: string, reference: string, by: { id: string; name: string }) {
  const plan = (await plansFor(shopId)).find((p) => p.code === planCode);
  if (!plan) throw AppError.validation('Choose a plan', [{ field: 'body.planCode', message: 'Choose a plan' }]);
  await canBuy(shopId, plan.code);
  const id = `manual_${randomBytes(9).toString('hex')}`;
  const offer = await discountFor(shopId);
  const { amount, off } = withOffer(plan.price, offer);
  await SubscriptionPaymentModel.create({ shopId, planCode: plan.code, planName: plan.name, durationDays: plan.durationDays, maxUsers: plan.maxUsers, amount, gst: amount - rhu(amount * 100, 118), discount: discountRecord(offer, off, plan.price), razorpayOrderId: id, status: 'created', source: 'manual', reference, createdBy: new Types.ObjectId(by.id), createdByName: by.name });
  const r = await markPaid(id, id, null, 'manual', by);
  return shapePayment(r.payment.toObject());
}

/** Step 2: Checkout hands back order, payment and signature; only a signature made with our secret counts. */
export async function verify(t: TenantContext, actor: Actor, input: { orderId: string; paymentId: string; signature: string }) {
  const pay = await SubscriptionPaymentModel.findOne({ shopId: t.shopId, razorpayOrderId: input.orderId }).lean();
  if (!pay) throw AppError.notFound('Payment not found');
  if (!(await checkPayment(input.orderId, input.paymentId, input.signature))) throw AppError.badRequest('The payment could not be verified', { reason: 'BAD_SIGNATURE' });
  // The signature is valid from authorisation on: time is given only for money Razorpay shows captured, at its amount.
  const g = await fetchPayment(input.paymentId);
  if (g && g.status !== 'captured') return { ...shapePayment(pay), replayed: false, confirming: true };
  const r = await markPaid(input.orderId, input.paymentId, g?.amount ?? null, g?.method ?? 'checkout', actor);
  return { ...shapePayment(r.payment.toObject()), replayed: r.replayed, confirming: false };
}

/** Test mode only: pays a test order the way Checkout would, with a real signature. Refused in production by config. */
export async function testPay(t: TenantContext, actor: Actor, orderId: string) {
  if ((await gateway()).mode !== 'test') throw AppError.forbidden('Test payments are off');
  const paymentId = `pay_test_${orderId.slice(-12)}`;
  return verify(t, actor, { orderId, paymentId, signature: await paymentSignature(orderId, paymentId) });
}

interface Hook {
  event?: string;
  payload?: { payment?: { entity?: PayEntity }; subscription?: { entity?: SubEntity }; refund?: { entity?: RefundEntity }; dispute?: { entity?: DisputeEntity } };
}

/** Step 3: the webhook, in case the browser closed after paying. Signed, logged once per event id, then the same markPaid. */
export async function webhook(raw: string, signature: string, eventId: string) {
  const valid = await checkWebhook(raw, signature);
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
    await signal('webhook_bad_signature');
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
  } else if ((type === 'payment.captured' || type === 'order.paid' || type === 'payment.failed') && e?.order_id && (await (await coins()).isCoinOrder(e.order_id))) {
    // D78: a coin pack, not a plan — its own credit, same idempotency.
    const c = await coins();
    if (type === 'payment.failed') {
      await c.coinOrderFailed(e.order_id, e.error_description ?? 'Payment failed');
      result = 'failed';
    } else if (e.id) {
      const r = await c.coinsPaid(e.order_id, e.id, typeof e.amount === 'number' ? e.amount : null, e.method ?? 'razorpay', null).catch((err: unknown) => {
        if (err instanceof AppError) return { error: err.message };
        throw err;
      });
      result = 'error' in r ? `error: ${r.error}` : r.replayed ? 'already paid' : 'tokens added';
    }
  } else if ((type === 'payment.captured' || type === 'order.paid' || type === 'payment.failed') && e?.order_id && (await (await addressPay()).isAddressOrder(e.order_id))) {
    // v1.24.1: the web address add-on — its own paid time, same idempotency.
    const w = await addressPay();
    if (type === 'payment.failed') {
      await w.addressOrderFailed(e.order_id, e.error_description ?? 'Payment failed');
      result = 'failed';
    } else if (e.id) {
      const r = await w.addressPaid(e.order_id, e.id, typeof e.amount === 'number' ? e.amount : null, e.method ?? 'razorpay', null).catch((err: unknown) => {
        if (err instanceof AppError) return { error: err.message };
        throw err;
      });
      result = 'error' in r ? `error: ${r.error}` : r.replayed ? 'already paid' : 'web address paid';
    }
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

/** MedBox24's tax invoice for a paid plan (CGST Rule 46), on the shared invoice layout. */
export async function invoicePdf(t: TenantContext, id: string) {
  const p = await SubscriptionPaymentModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), status: 'paid' }).lean();
  if (!p?.invoiceNumber || !p.periodStart || !p.periodEnd) throw AppError.notFound('Invoice not found');
  const from = p.invoiceFrom ?? (await supplier());
  const to = p.invoiceTo ?? (await buyerOf(p.shopId));
  const support = (await platform()).supportEmail;
  const period = `${day(p.periodStart)} – ${day(p.periodEnd)}`;
  const how = p.source === 'test' ? 'Test payment' : p.source === 'manual' ? `Paid outside Razorpay${p.reference ? ` · ${p.reference}` : ''}` : `Paid by ${p.method ?? 'Razorpay'}${p.razorpayPaymentId ? ` · ${p.razorpayPaymentId}` : ''}`;
  const sac = (await billingInfo()).sac;
  const plan = { amount: p.amount - (p.charge?.amount ?? 0), gst: p.gst - (p.charge?.gst ?? 0) };
  const buf = await invoiceDoc({
    size: 'A4',
    title: 'TAX INVOICE',
    meta: [['Invoice no.', p.invoiceNumber], ['Date', day(p.paidAt ?? new Date())], ['Place of supply', placeOf(to)], ['Reverse charge', 'No']],
    stamp: 'PAID',
    issuer: issuerOf(from, support),
    logo: true,
    parties: [billedTo(to), { label: 'Subscription', lines: [`${p.planName} plan · up to ${String(p.maxUsers)} users`, `Period ${period}`, how] }],
    columns: SUB_COLUMNS,
    rows: [
      p.kind === 'upgrade'
        ? { cells: ['1', `MedBox24 software subscription — upgrade from ${p.upgrade?.fromName ?? 'Basic'} to ${p.planName}`, sac, rupees(plan.amount - plan.gst), '18%', rupees(plan.amount)], sub: `The ${String(p.durationDays)} days already paid for move to ${p.planName} · up to ${String(p.maxUsers)} users · ${period}` }
        : { cells: ['1', `MedBox24 software subscription — ${p.planName}`, sac, rupees(plan.amount - plan.gst), '18%', rupees(plan.amount)], sub: `${String(p.durationDays)} days · up to ${String(p.maxUsers)} users · ${period}${p.discount ? ` · price ${inr(p.discount.listAmount)} less ${String(p.discount.pct)}% referral discount ${inr(p.discount.off)}` : ''}` },
      ...chargeRow(2, p.charge, sac),
    ],
    totals: [{ label: 'Taxable value', value: rupees(p.amount - p.gst) }, ...gstLines(p.gst, from, to), { label: 'Total', value: rupees(p.amount), strong: true }],
    words: rupeesInWords(p.amount),
    notes: ['Thank you for running your shop on MedBox24.', ...(support ? [`Questions about this invoice: ${support}`] : [])],
    footer: `Computer-generated invoice — no signature needed · ${from.name ?? 'MedBox24'}`,
  });
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
