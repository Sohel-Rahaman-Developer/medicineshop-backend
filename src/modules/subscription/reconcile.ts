import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { logger } from '../../config/logger';
import { fetchRefunds, fetchSubscription, orderPayments, subscriptionInvoices } from '../../services/razorpay';
import { auditSettled, charge, settleRefund } from './autopay';
import { AutopayModel, SubscriptionPaymentModel } from './billing.model';
import { markPaid } from './subscription.service';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const quiet = (err: unknown) => {
  if (err instanceof AppError) return null;
  throw err;
};

/**
 * Hourly (razorpay mode): money Razorpay holds that neither Checkout nor a webhook reported — a webhook is switched off
 * after 24 hours of failures. Everything lands in the same markPaid / charge / settleRefund, so a repeat changes nothing.
 */
export async function reconcile(now = new Date()) {
  const out = { orders: 0, charges: 0, refunds: 0 };
  if (env.PAYMENTS_MODE === 'off') return out;

  // One-time orders still unpaid 10 minutes to 3 days after Checkout opened (Razorpay refunds uncaptured ones after 3 days).
  const orders = await SubscriptionPaymentModel.find({ source: { $in: ['razorpay', 'test'] }, status: { $in: ['created', 'failed'] }, createdAt: { $lt: new Date(now.getTime() - 10 * MIN), $gt: new Date(now.getTime() - 3 * DAY) } }).select('razorpayOrderId').limit(100).lean();
  for (const o of orders) {
    const paid = (await orderPayments(o.razorpayOrderId)).find((x) => x.status === 'captured');
    if (!paid) continue;
    const r = await markPaid(o.razorpayOrderId, paid.id, paid.amount, paid.method ?? 'razorpay', null, now).catch(quiet);
    if (r && !r.replayed) out.orders++;
  }

  // Autopay charges Razorpay counted and we didn't.
  for (const a of await AutopayModel.find({ status: { $in: ['authenticated', 'active', 'pending', 'halted'] } }).select('rzpSubscriptionId paidCount').lean()) {
    const s = await fetchSubscription(a.rzpSubscriptionId);
    if (!s || s.paid_count <= a.paidCount) continue;
    for (const inv of await subscriptionInvoices(a.rzpSubscriptionId)) {
      if (inv.status !== 'paid' || !inv.payment_id) continue;
      const r = await charge(a.rzpSubscriptionId, inv.payment_id, inv.amount_paid ?? inv.amount, 'autopay', null, null, now).catch(quiet);
      if (r && !r.replayed) out.charges++;
    }
  }

  // Refunds reserved but never settled (the server stopped between Razorpay's answer and our save).
  const stuck = await SubscriptionPaymentModel.find({ refunds: { $elemMatch: { status: 'pending', rzpRefundId: { $exists: false }, at: { $lt: new Date(now.getTime() - 10 * MIN) } } } }).limit(50).lean();
  for (const p of stuck) {
    const made = p.source === 'manual' ? [] : await fetchRefunds(p.razorpayPaymentId ?? '');
    for (const r of p.refunds) {
      if (r.status !== 'pending' || r.rzpRefundId || r.at > new Date(now.getTime() - 10 * MIN)) continue;
      const gw = made.find((x) => x.receipt === String(r._id));
      // Not at Razorpay an hour later → it never happened: release the amount.
      if (!gw && r.at > new Date(now.getTime() - 60 * MIN)) continue;
      const s = await settleRefund(p._id, String(r._id), gw ?? { id: '', status: 'failed' }, now);
      await auditSettled(s);
      if (s.settled) out.refunds++;
    }
  }
  if (out.orders + out.charges + out.refunds) logger.warn(out, 'Reconcile booked payments the webhooks missed');
  return out;
}
