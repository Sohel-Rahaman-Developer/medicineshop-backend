import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { day, rupees } from '../../core/export';
import { AppError } from '../../core/errors';
import { invoicePdf as invoiceDoc } from '../../core/invoice-pdf';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { inr, rhu } from '../../utils/money';
import { rupeesInWords } from '../../utils/words';
import { checkPayment, createOrder, fetchPayment, paymentSignature } from '../../services/razorpay';
import { log } from '../admin/admin.service';
import type { AdminActor } from '../admin/admin-auth';
import { platform } from '../admin/platform';
import { audit } from '../audit/audit.model';
import { ShopModel } from '../shops/shop.model';
import { billingInfo, gateway } from '../subscription/gateway';
import { statusAt } from '../subscription/subscription.model';
import { SUB_COLUMNS, billedTo, buyerOf, gstLines, issuerOf, nextInvoice, placeOf, supplier } from '../subscription/subscription.service';
import type { Actor } from '../user/actor';
import { OwnDomainModel } from '../owndomain/own-domain.model';
import { domainStateOf, domainUrl, forgetLiveDomains } from '../owndomain/own-domain.service';
import { WebAddressModel, WebAddressPaymentModel, type AddressPeriod } from './web-address.model';
import { addressUrl, forgetLive, prices, stateOf } from './web-address.service';

// v1.24.1: the web address add-on, a month or a year at a time — Razorpay Checkout in the shop app, or cash / UPI the
// accounts desk records. Paid time starts where the trial, free or paid time ends; the same tax invoice as a plan.

const DAY = 86_400_000;
const DAYS: Record<AddressPeriod, number> = { month: 30, year: 365 };
const LABEL: Record<AddressPeriod, string> = { month: '1 month', year: '1 year' };

/** v1.26: the add-on on the web address or on the shop's own domain, or the yearly price of a domain MedBox24 buys. */
export type PayTarget = 'subdomain' | 'domain';
export type PayWhat = 'addon' | 'domain';
const urlOf = (target: string, name: string) => (target === 'domain' ? domainUrl(name) : addressUrl(name)).replace(/^https?:\/\//, '');
const labelOf = (target: string, what: string, name: string, period: AddressPeriod) => (what === 'domain' ? `${name} · domain for 1 year` : `${urlOf(target, name)} · ${LABEL[period]}`);

interface PayRow { _id: Types.ObjectId; slug: string; target?: string | null; what?: string | null; period: string; days: number; amount: number; gst: number; status: string; invoiceNumber?: string | null; periodStart?: Date | null; periodEnd?: Date | null; source: string; method?: string | null; createdAt?: Date; paidAt?: Date | null; failureReason?: string | null }
export const shapePay = (p: PayRow) => ({ id: String(p._id), name: p.slug, target: (p.target ?? 'subdomain') as PayTarget, what: (p.what ?? 'addon') as PayWhat, label: labelOf(p.target ?? 'subdomain', p.what ?? 'addon', p.slug, p.period as AddressPeriod), period: p.period as AddressPeriod, days: p.days, amount: p.amount, gst: p.gst, status: p.status, invoiceNumber: p.invoiceNumber ?? null, periodStart: p.periodStart ?? null, periodEnd: p.periodEnd ?? null, source: p.source, method: p.method ?? null, createdAt: p.createdAt ?? null, paidAt: p.paidAt ?? null, failureReason: p.failureReason ?? null });

async function planRuns(shopId: Types.ObjectId) {
  const s = await stateOf({ _id: shopId, shopId, slug: '', status: 'active' });
  if (!s.sub || ['expired', 'cancelled'].includes(statusAt(s.sub, new Date()))) throw AppError.conflict('Renew your plan first — the web address works with a running plan');
}

/** v1.26: the own domain's add-on (once switched on) or its name (a bought one, after the team sets the price). */
async function quoteDomain(shopId: Types.ObjectId, period: AddressPeriod, what: PayWhat) {
  const r = await OwnDomainModel.findOne({ shopId, status: { $in: ['requested', 'active', 'stopped'] } }).lean();
  if (!r) throw AppError.conflict('Ask for your own domain first');
  if (r.status === 'stopped') throw AppError.conflict('MedBox24 stopped this domain — call MedBox24');
  await planRuns(shopId);
  if (what === 'domain') {
    if (r.kind !== 'buy') throw AppError.conflict('You have this domain already — there is nothing to buy');
    if (!r.buyPrice) throw AppError.conflict('MedBox24 will call you with the domain’s price first');
    return { id: r._id, name: r.domain, days: DAYS.year, amount: r.buyPrice, gst: r.buyPrice - rhu(r.buyPrice * 100, 118) };
  }
  if (r.status === 'requested') throw AppError.conflict('Your domain is not switched on yet');
  const amount = (await prices())[period];
  if (!amount) throw AppError.validation('Choose a period', [{ field: 'body.period', message: 'Choose a period' }]);
  return { id: r._id, name: r.domain, days: DAYS[period], amount, gst: amount - rhu(amount * 100, 118) };
}

async function quoteFor(shopId: Types.ObjectId, period: AddressPeriod, target: PayTarget, what: PayWhat) {
  if (target === 'domain') return quoteDomain(shopId, what === 'domain' ? 'year' : period, what);
  const q = await quote(shopId, period);
  return { id: q.r._id, name: q.r.slug, days: DAYS[period], amount: q.amount, gst: q.gst };
}

/** What the shop's address costs for a period; refused when it can't be paid for now. */
async function quote(shopId: Types.ObjectId, period: AddressPeriod) {
  const r = await WebAddressModel.findOne({ shopId, status: { $in: ['requested', 'active', 'stopped'] } }).lean();
  if (!r || r.status === 'requested') throw AppError.conflict('Your web address is not approved yet');
  if (r.status === 'stopped') throw AppError.conflict('MedBox24 stopped this address — call MedBox24');
  const s = await stateOf(r);
  if (!s.sub || ['expired', 'cancelled'].includes(statusAt(s.sub, new Date()))) throw AppError.conflict('Renew your plan first — the web address works with a running plan');
  const amount = (await prices())[period];
  if (!amount) throw AppError.validation('Choose a period', [{ field: 'body.period', message: 'Choose a period' }]);
  return { r, amount, gst: amount - rhu(amount * 100, 118) };
}

/** Settings → Web address: the add-on's payments, and whether the shop can pay online. */
export async function payInfo(t: TenantContext) {
  const [g, rows] = await Promise.all([gateway(), WebAddressPaymentModel.find({ shopId: t.shopId, status: 'paid' }).sort({ createdAt: -1 }).limit(24).lean()]);
  return { payments: rows.map(shapePay), payMode: g.mode };
}

/** A Razorpay order for the add-on, its 18% GST inside — the plan purchase, for the address. */
export async function orderAddress(t: TenantContext, actor: Actor, period: AddressPeriod, target: PayTarget = 'subdomain', what: PayWhat = 'addon') {
  const g = await gateway();
  if (g.mode === 'off') throw AppError.forbidden('Online payment is off — MedBox24 will call you');
  const q = await quoteFor(t.shopId, period, target, what);
  const per = what === 'domain' ? 'year' : period;
  const receipt = `${String(t.shopId).slice(-8)}-w${Date.now().toString(36)}`;
  const orderId = await createOrder(q.amount, receipt, { shopId: String(t.shopId), kind: target === 'domain' ? `own_domain_${what}` : 'web_address', period: per });
  await WebAddressPaymentModel.create({ shopId: t.shopId, addressId: q.id, slug: q.name, target, what, period: per, days: q.days, amount: q.amount, gst: q.gst, razorpayOrderId: orderId, source: g.mode === 'test' ? 'test' : 'razorpay', createdBy: new Types.ObjectId(actor.id), createdByName: actor.name });
  return { orderId, amount: q.amount, currency: 'INR', label: labelOf(target, what, q.name, per), keyId: g.mode === 'razorpay' ? g.keyId : null, mode: g.mode, shopName: t.shopName };
}

/** Checkout's verify, the webhook and the hourly check all land here: time once per order, a second call is a no-op. */
export async function addressPaid(orderId: string, paymentId: string, amount: number | null, method: string, by: { id: string; name: string } | null, now = new Date()) {
  const ordered = await WebAddressPaymentModel.findOne({ razorpayOrderId: orderId }).select('amount status').lean();
  if (ordered && amount !== null && amount !== ordered.amount && ordered.status !== 'paid') {
    await WebAddressPaymentModel.updateOne({ razorpayOrderId: orderId, status: { $ne: 'paid' } }, { $set: { status: 'failed', failureReason: `Amount ${inr(amount)} does not match ${inr(ordered.amount)}` } });
    throw AppError.conflict('The paid amount does not match the order', { reason: 'AMOUNT_MISMATCH' });
  }
  const out = await inTransaction(async (session) => {
    const pay = await WebAddressPaymentModel.findOne({ razorpayOrderId: orderId }).session(session);
    if (!pay) throw AppError.notFound('Payment not found');
    if (pay.status === 'paid') {
      if (pay.razorpayPaymentId !== paymentId) throw AppError.conflict('This order is already paid with another payment', { reason: 'ALREADY_PAID' });
      return { payment: pay, replayed: true };
    }
    // Money taken is time given, even if the address was stopped meanwhile: the team sorts that out on the call.
    let start: Date;
    if (pay.target === 'domain') {
      const dom = await OwnDomainModel.findOne({ _id: pay.addressId, shopId: pay.shopId }).session(session);
      if (!dom) throw AppError.internal();
      const covered = pay.what === 'domain' ? (dom.domainPaidUntil ?? null) : (await domainStateOf(dom.toObject(), now)).lastLive;
      start = covered && covered > now ? covered : now;
      dom.set(pay.what === 'domain' ? { domainPaidUntil: new Date(start.getTime() + pay.days * DAY) } : { paidUntil: new Date(start.getTime() + pay.days * DAY) });
      await dom.save({ session });
    } else {
      const addr = await WebAddressModel.findOne({ _id: pay.addressId, shopId: pay.shopId }).session(session);
      if (!addr) throw AppError.internal();
      const covered = (await stateOf(addr.toObject(), now)).lastLive;
      start = covered && covered > now ? covered : now;
      addr.set({ paidUntil: new Date(start.getTime() + pay.days * DAY) });
      await addr.save({ session });
    }
    const end = new Date(start.getTime() + pay.days * DAY);
    const invoiceNumber = await nextInvoice(now, session);
    pay.set({ status: 'paid', razorpayPaymentId: paymentId, method, paidAt: now, periodStart: start, periodEnd: end, invoiceNumber, invoiceFrom: await supplier(), invoiceTo: await buyerOf(pay.shopId, session), failureReason: undefined });
    await pay.save({ session });
    const who = by ?? { id: String(pay.createdBy), name: pay.createdByName };
    const what = pay.what === 'domain' ? `the domain ${pay.slug}` : `the web address ${urlOf(pay.target, pay.slug)}`;
    await audit({ shopId: pay.shopId, userId: who.id, userName: who.name, action: 'update', module: 'subscription', entityId: String(pay._id), entityName: invoiceNumber, text: `${who.name} paid ${inr(pay.amount)} for ${what} — paid till ${day(end)} (${invoiceNumber})` }, session);
    return { payment: pay, replayed: false };
  });
  forgetLive();
  forgetLiveDomains();
  return out;
}

export async function verifyAddress(t: TenantContext, actor: Actor, input: { orderId: string; paymentId: string; signature: string }) {
  const p = await WebAddressPaymentModel.findOne({ shopId: t.shopId, razorpayOrderId: input.orderId }).lean();
  if (!p) throw AppError.notFound('Payment not found');
  if (!(await checkPayment(input.orderId, input.paymentId, input.signature))) throw AppError.badRequest('The payment could not be verified', { reason: 'BAD_SIGNATURE' });
  // Time only for money Razorpay shows captured, at its amount.
  const g = await fetchPayment(input.paymentId);
  if (g && g.status !== 'captured') return { ...shapePay(p), confirming: true, replayed: false };
  const r = await addressPaid(input.orderId, input.paymentId, g?.amount ?? null, g?.method ?? 'checkout', actor);
  return { ...shapePay(r.payment.toObject()), confirming: false, replayed: r.replayed };
}

/** Test mode only: pays a test order the way Checkout would. */
export async function testPayAddress(t: TenantContext, actor: Actor, orderId: string) {
  if ((await gateway()).mode !== 'test') throw AppError.forbidden('Test payments are off');
  const paymentId = `pay_test_${orderId.slice(-12)}`;
  return verifyAddress(t, actor, { orderId, paymentId, signature: await paymentSignature(orderId, paymentId) });
}

/** Webhook: is this Razorpay order a web address payment? */
export const isAddressOrder = async (orderId: string) => Boolean(await WebAddressPaymentModel.exists({ razorpayOrderId: orderId }));
export async function addressOrderFailed(orderId: string, reason: string) {
  await WebAddressPaymentModel.updateOne({ razorpayOrderId: orderId, status: 'created' }, { $set: { status: 'failed', failureReason: reason } });
}

/** Unpaid online orders from 10 minutes to 3 days old, for the hourly check against Razorpay. */
export const openOrders = (now: Date) => WebAddressPaymentModel.find({ source: { $in: ['razorpay', 'test'] }, status: { $in: ['created', 'failed'] }, createdAt: { $lt: new Date(now.getTime() - 10 * 60_000), $gt: new Date(now.getTime() - 3 * DAY) } }).select('razorpayOrderId').limit(100).lean();

/** Accounts desk: cash or UPI taken by hand — the same time and invoice as an online payment. */
export async function recordAddressManual(a: AdminActor, id: string, period: AddressPeriod, reference: string, reason: string, ip?: string, target: PayTarget = 'subdomain', what: PayWhat = 'addon') {
  const rec = target === 'domain' ? await OwnDomainModel.findOne({ _id: new Types.ObjectId(id) }, null, { crossTenant: true }).select('shopId').lean() : await WebAddressModel.findOne({ _id: new Types.ObjectId(id) }, null, { crossTenant: true }).select('shopId').lean();
  if (!rec) throw AppError.notFound(target === 'domain' ? 'Domain not found' : 'Web address not found');
  const q = await quoteFor(rec.shopId, period, target, what);
  const per = what === 'domain' ? 'year' : period;
  const orderId = `manual_${randomBytes(9).toString('hex')}`;
  const by = { id: a.id, name: `MedBox24 · ${a.name}` };
  await WebAddressPaymentModel.create({ shopId: rec.shopId, addressId: q.id, slug: q.name, target, what, period: per, days: q.days, amount: q.amount, gst: q.gst, razorpayOrderId: orderId, source: 'manual', reference, createdBy: new Types.ObjectId(a.id), createdByName: by.name });
  const p = shapePay((await addressPaid(orderId, orderId, null, 'manual', by)).payment.toObject());
  const shop = await ShopModel.findById(rec.shopId).select('name').lean();
  await log(a, target === 'domain' ? 'own_domain_payment' : 'web_address_payment', reason, `recorded ${inr(p.amount)} for ${p.label} (${reference}) — invoice ${p.invoiceNumber ?? ''}`, { id: rec.shopId, name: shop?.name ?? '' }, undefined, ip);
  return p;
}

/** MedBox24's tax invoice for the add-on (CGST Rule 46), on the shared invoice layout. */
export async function addressInvoicePdf(t: TenantContext, id: string) {
  const p = await WebAddressPaymentModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), status: 'paid' }).lean();
  if (!p?.invoiceNumber || !p.periodStart || !p.periodEnd) throw AppError.notFound('Invoice not found');
  const from = p.invoiceFrom ?? (await supplier());
  const to = p.invoiceTo ?? (await buyerOf(p.shopId));
  const support = (await platform()).supportEmail;
  const url = urlOf(p.target, p.slug);
  const period = `${day(p.periodStart)} – ${day(p.periodEnd)}`;
  const item = p.what === 'domain' ? `Domain name ${p.slug} — registration for 1 year` : `MedBox24 web address — ${url}`;
  const how = p.source === 'test' ? 'Test payment' : p.source === 'manual' ? `Paid to MedBox24 by hand${p.reference ? ` · ${p.reference}` : ''}` : `Paid by ${p.method ?? 'Razorpay'}${p.razorpayPaymentId ? ` · ${p.razorpayPaymentId}` : ''}`;
  const buf = await invoiceDoc({
    size: 'A4',
    title: 'TAX INVOICE',
    meta: [['Invoice no.', p.invoiceNumber], ['Date', day(p.paidAt ?? new Date())], ['Place of supply', placeOf(to)], ['Reverse charge', 'No']],
    stamp: 'PAID',
    issuer: issuerOf(from, support),
    logo: true,
    parties: [billedTo(to), { label: p.what === 'domain' ? 'Domain' : 'Web address', lines: [url, `Period ${period}`, how] }],
    columns: SUB_COLUMNS,
    rows: [{ cells: ['1', item, (await billingInfo()).sac, rupees(p.amount - p.gst), '18%', rupees(p.amount)], sub: `${String(p.days)} days · ${period}` }],
    totals: [{ label: 'Taxable value', value: rupees(p.amount - p.gst) }, ...gstLines(p.gst, from, to), { label: 'Total', value: rupees(p.amount), strong: true }],
    words: rupeesInWords(p.amount),
    notes: ['Thank you for running your shop on MedBox24.', ...(support ? [`Questions about this invoice: ${support}`] : [])],
    footer: `Computer-generated invoice — no signature needed · ${from.name ?? 'MedBox24'}`,
  });
  return { buf, name: p.invoiceNumber };
}
