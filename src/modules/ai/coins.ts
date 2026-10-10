import { Types, type ClientSession } from 'mongoose';
import { env } from '../../config/env';
import { day, rupees } from '../../core/export';
import { AppError } from '../../core/errors';
import { invoicePdf as invoiceDoc } from '../../core/invoice-pdf';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { inr, rhu } from '../../utils/money';
import { rupeesInWords } from '../../utils/words';
import { checkPayment, createOrder, fetchPayment, paymentSignature, type GwPayment } from '../../services/razorpay';
import { audit } from '../audit/audit.model';
import { platform } from '../admin/platform';
import { SUB_COLUMNS, billedTo, buyerOf, gstLines, issuerOf, nextInvoice, placeOf, supplier } from '../subscription/subscription.service';
import type { Actor } from '../user/actor';
import { AskQuestionModel } from '../ask/ask.model';
import { aiOffer, aiSettings } from './ai-settings';
import { AiReadModel, CoinEntryModel, CoinOrderModel, CoinWalletModel, type CoinKind } from './ai.model';

const NOT_ENOUGH = 'NOT_ENOUGH_COINS';

/** Coins in or out with their ledger line, in the caller's transaction. Never below zero. */
export async function moveCoins(shopId: Types.ObjectId, kind: CoinKind, coins: number, text: string, byName: string, ref: string, session: ClientSession): Promise<number> {
  const w =
    coins < 0
      ? await CoinWalletModel.findOneAndUpdate({ shopId, balance: { $gte: -coins } }, { $inc: { balance: coins } }, { returnDocument: 'after', session }).lean()
      : await CoinWalletModel.findOneAndUpdate({ shopId }, { $inc: { balance: coins } }, { upsert: true, returnDocument: 'after', session }).lean();
  if (!w) {
    const have = (await CoinWalletModel.findOne({ shopId }).session(session).lean())?.balance ?? 0;
    throw AppError.conflict(`Not enough coins — this needs ${String(-coins)}, the shop has ${String(have)}`, { reason: NOT_ENOUGH, need: -coins, have });
  }
  await CoinEntryModel.create([{ shopId, kind, coins, balance: w.balance, text, ref, byName }], { session });
  return w.balance;
}

export async function balanceOf(shopId: Types.ObjectId) {
  return (await CoinWalletModel.findOne({ shopId }).lean())?.balance ?? 0;
}

const shapeOrder = (o: { _id: Types.ObjectId; packName: string; coins: number; amount: number; gst: number; status: string; invoiceNumber?: string | null; paidAt?: Date | null; createdAt: Date; failureReason?: string | null; source: string }) => ({
  id: String(o._id),
  packName: o.packName,
  coins: o.coins,
  amount: o.amount,
  gst: o.gst,
  status: o.status,
  invoiceNumber: o.invoiceNumber ?? null,
  paidAt: o.paidAt ?? null,
  createdAt: o.createdAt,
  failureReason: o.failureReason ?? null,
  source: o.source,
});

export const shapeRead = (r: { _id: Types.ObjectId; userName: string; supplierName: string; fileName: string; fileType: string; pages: number; coins: number; status: string; refunded: boolean; lines: number; error?: string | null; createdAt: Date }) => ({
  id: String(r._id),
  userName: r.userName,
  supplierName: r.supplierName,
  fileName: r.fileName,
  fileType: r.fileType,
  pages: r.pages,
  coins: r.coins,
  status: r.status,
  refunded: r.refunded,
  lines: r.lines,
  error: r.error ?? null,
  createdAt: r.createdAt,
});

/** The shop's coin page: balance, packs, every coin in or out, its AI reads and its coin invoices. */
export async function wallet(t: TenantContext) {
  const [offer, s, w, entries, reads, questions, orders] = await Promise.all([
    aiOffer(),
    aiSettings(),
    CoinWalletModel.findOne({ shopId: t.shopId }).lean(),
    CoinEntryModel.find({ shopId: t.shopId }).sort({ createdAt: -1, _id: -1 }).limit(100).lean(),
    AiReadModel.find({ shopId: t.shopId }).sort({ createdAt: -1, _id: -1 }).limit(50).lean(),
    AskQuestionModel.find({ shopId: t.shopId, route: { $in: ['ai', 'off_topic'] } }).sort({ createdAt: -1, _id: -1 }).limit(50).lean(),
    CoinOrderModel.find({ shopId: t.shopId, status: { $in: ['paid', 'failed'] } }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  return {
    ...offer,
    balance: w?.balance ?? 0,
    payments: env.PAYMENTS_MODE,
    ask: { available: s.chat.enabled && s.hasKey, on: Boolean(w?.askAi), by: w?.askAiBy ?? null, at: w?.askAiAt ?? null, coinsPerQuestion: s.chat.coinsPerQuestion, freeLeft: Math.max(0, s.chat.freeQuestions - (w?.askFree ?? 0)) },
    questions: questions.map((q) => ({ id: String(q._id), userName: q.userName, offTopic: q.route === 'off_topic', status: q.status, free: q.free, coins: q.coins, refunded: q.refunded, error: q.error ?? null, at: q.createdAt })),
    entries: entries.map((e) => ({ id: String(e._id), kind: e.kind, coins: e.coins, balance: e.balance, text: e.text, byName: e.byName, at: e.createdAt })),
    reads: reads.map(shapeRead),
    orders: orders.map(shapeOrder),
  };
}

/** A Razorpay order for a coin pack, at its price with the 18% GST inside it — the plan purchase, for coins. */
export async function orderCoins(t: TenantContext, actor: Actor, packCode: string) {
  const offer = await aiOffer();
  if (!offer.enabled) throw AppError.forbidden('AI bill reading is off');
  if (env.PAYMENTS_MODE === 'off') throw AppError.forbidden('Online payment is off — ask MedBox24 to add coins');
  const pack = offer.packs.find((p) => p.code === packCode);
  if (!pack) throw AppError.validation('Choose a pack', [{ field: 'body.packCode', message: 'Choose a pack' }]);
  const receipt = `${String(t.shopId).slice(-8)}-c${Date.now().toString(36)}`;
  const orderId = await createOrder(pack.price, receipt, { shopId: String(t.shopId), coins: String(pack.coins), kind: 'coins' });
  await CoinOrderModel.create({ shopId: t.shopId, packCode: pack.code, packName: pack.name, coins: pack.coins, amount: pack.price, gst: pack.price - rhu(pack.price * 100, 118), razorpayOrderId: orderId, source: env.PAYMENTS_MODE === 'test' ? 'test' : 'razorpay', createdBy: new Types.ObjectId(actor.id), createdByName: actor.name });
  return { orderId, amount: pack.price, currency: 'INR', packName: `${pack.name} · ${String(pack.coins)} coins`, keyId: env.PAYMENTS_MODE === 'razorpay' ? (env.RAZORPAY_KEY_ID ?? null) : null, mode: env.PAYMENTS_MODE, shopName: t.shopName };
}

/** Checkout's verify and the webhook both land here: coins once per order, a second call is a no-op. */
export async function coinsPaid(orderId: string, paymentId: string, amount: number | null, method: string, by: { id: string; name: string } | null, now = new Date()) {
  const ordered = await CoinOrderModel.findOne({ razorpayOrderId: orderId }).select('amount status').lean();
  if (ordered && amount !== null && amount !== ordered.amount && ordered.status !== 'paid') {
    await CoinOrderModel.updateOne({ razorpayOrderId: orderId, status: { $ne: 'paid' } }, { $set: { status: 'failed', failureReason: `Amount ${inr(amount)} does not match ${inr(ordered.amount)}` } });
    throw AppError.conflict('The paid amount does not match the order', { reason: 'AMOUNT_MISMATCH' });
  }
  return inTransaction(async (session) => {
    const o = await CoinOrderModel.findOne({ razorpayOrderId: orderId }).session(session);
    if (!o) throw AppError.notFound('Order not found');
    if (o.status === 'paid') {
      if (o.razorpayPaymentId !== paymentId) throw AppError.conflict('This order is already paid with another payment', { reason: 'ALREADY_PAID' });
      return { order: o, replayed: true, balance: await balanceOf(o.shopId) };
    }
    const invoiceNumber = await nextInvoice(now, session);
    o.set({ status: 'paid', razorpayPaymentId: paymentId, method, paidAt: now, invoiceNumber, invoiceFrom: supplier(), invoiceTo: await buyerOf(o.shopId, session), failureReason: undefined });
    await o.save({ session });
    const who = by ?? { id: String(o.createdBy), name: o.createdByName };
    const balance = await moveCoins(o.shopId, 'purchase', o.coins, `Bought ${o.packName} — ${inr(o.amount)} (${invoiceNumber})`, who.name, String(o._id), session);
    await audit({ shopId: o.shopId, userId: who.id, userName: who.name, action: 'update', module: 'subscription', entityId: String(o._id), entityName: invoiceNumber, text: `${who.name} bought ${String(o.coins)} AI coins for ${inr(o.amount)} (${invoiceNumber})` }, session);
    return { order: o, replayed: false, balance };
  });
}

export async function verifyCoins(t: TenantContext, actor: Actor, input: { orderId: string; paymentId: string; signature: string }) {
  const o = await CoinOrderModel.findOne({ shopId: t.shopId, razorpayOrderId: input.orderId }).lean();
  if (!o) throw AppError.notFound('Order not found');
  if (!checkPayment(input.orderId, input.paymentId, input.signature)) throw AppError.badRequest('The payment could not be verified', { reason: 'BAD_SIGNATURE' });
  const g: GwPayment | null = await fetchPayment(input.paymentId);
  if (g && g.status !== 'captured') return { ...shapeOrder(o), confirming: true, replayed: false, balance: await balanceOf(t.shopId) };
  const r = await coinsPaid(input.orderId, input.paymentId, g?.amount ?? null, g?.method ?? 'checkout', actor);
  return { ...shapeOrder(r.order.toObject()), confirming: false, replayed: r.replayed, balance: r.balance };
}

/** Test mode only: pays a test order the way Checkout would. */
export async function testPayCoins(t: TenantContext, actor: Actor, orderId: string) {
  if (env.PAYMENTS_MODE !== 'test') throw AppError.forbidden('Test payments are off');
  const paymentId = `pay_test_${orderId.slice(-12)}`;
  return verifyCoins(t, actor, { orderId, paymentId, signature: paymentSignature(orderId, paymentId) });
}

/** Webhook: is this Razorpay order a coin pack? */
export const isCoinOrder = async (orderId: string) => Boolean(await CoinOrderModel.exists({ razorpayOrderId: orderId }));
export async function coinOrderFailed(orderId: string, reason: string) {
  await CoinOrderModel.updateOne({ razorpayOrderId: orderId, status: 'created' }, { $set: { status: 'failed', failureReason: reason } });
}

/** MedBox24's tax invoice for a coin pack (CGST Rule 46), on the shared invoice layout. */
export async function coinInvoicePdf(t: TenantContext, id: string) {
  const o = await CoinOrderModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), status: 'paid' }).lean();
  if (!o?.invoiceNumber) throw AppError.notFound('Invoice not found');
  const from = o.invoiceFrom ?? supplier();
  const to = o.invoiceTo ?? (await buyerOf(o.shopId));
  const support = (await platform()).supportEmail;
  const how = o.source === 'test' ? 'Test payment' : `Paid by ${o.method ?? 'Razorpay'}${o.razorpayPaymentId ? ` · ${o.razorpayPaymentId}` : ''}`;
  const buf = await invoiceDoc({
    size: 'A4',
    title: 'TAX INVOICE',
    meta: [['Invoice no.', o.invoiceNumber], ['Date', day(o.paidAt ?? new Date())], ['Place of supply', placeOf(to)], ['Reverse charge', 'No']],
    stamp: 'PAID',
    issuer: issuerOf(from, support),
    logo: true,
    parties: [billedTo(to), { label: 'AI coins', lines: [`${o.packName} · ${String(o.coins)} coins`, 'For reading supplier bills with AI', how] }],
    columns: SUB_COLUMNS,
    rows: [{ cells: ['1', `MedBox24 AI bill reading — ${String(o.coins)} coins`, env.BILLING_SAC, rupees(o.amount - o.gst), '18%', rupees(o.amount)], sub: `${o.packName} pack` }],
    totals: [{ label: 'Taxable value', value: rupees(o.amount - o.gst) }, ...gstLines(o.gst, from, to), { label: 'Total', value: rupees(o.amount), strong: true }],
    words: rupeesInWords(o.amount),
    notes: ['Coins do not expire and are not refundable as cash.', ...(support ? [`Questions about this invoice: ${support}`] : [])],
    footer: `Computer-generated invoice — no signature needed · ${from.name ?? 'MedBox24'}`,
  });
  return { buf, name: o.invoiceNumber };
}
