import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { AppError } from '../core/errors';

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

/** GET without a body, POST with one. */
async function rzp<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID ?? ''}:${env.RAZORPAY_KEY_SECRET ?? ''}`).toString('base64')}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
    throw AppError.serviceUnavailable(e.error?.description ? `Razorpay: ${e.error.description}` : 'The payment gateway did not answer. Please try again.');
  }
  return (await res.json()) as T;
}

/** Off refuses; test mode makes local ids (signatures stay real HMAC); razorpay calls the API. */
function live() {
  if (env.PAYMENTS_MODE === 'off') throw AppError.serviceUnavailable('Online payment isn’t set up yet. Please contact MedShop support.');
  return env.PAYMENTS_MODE === 'razorpay';
}
const testId = (prefix: string) => `${prefix}_test_${randomBytes(9).toString('hex')}`;
const isTest = (id: string) => id.includes('_test_');

/** Razorpay Orders (PLAN §8): a one-time payment. */
export async function createOrder(amount: number, receipt: string, notes: Record<string, string>): Promise<string> {
  if (!live()) return testId('order');
  return (await rzp<{ id: string }>('/orders', { amount, currency: 'INR', receipt, notes })).id;
}

/** B8c autopay: a plan at one price, charged every month or year. */
export async function createPlan(period: 'monthly' | 'yearly', amount: number, name: string): Promise<string> {
  if (!live()) return testId('plan');
  return (await rzp<{ id: string }>('/plans', { period, interval: 1, item: { name, amount, currency: 'INR' } })).id;
}

/** The mandate the owner approves in Checkout (UPI Autopay or card). `startAt` empty → the first charge is now. */
export async function createSubscription(planId: string, totalCount: number, startAt: Date | null, notes: Record<string, string>): Promise<string> {
  if (!live()) return testId('sub');
  return (await rzp<{ id: string }>('/subscriptions', { plan_id: planId, total_count: totalCount, quantity: 1, customer_notify: 1, ...(startAt ? { start_at: Math.floor(startAt.getTime() / 1000) } : {}), notes })).id;
}

export async function cancelSubscription(id: string): Promise<void> {
  if (isTest(id) || !live()) return;
  await rzp(`/subscriptions/${id}/cancel`, { cancel_at_cycle_end: 0 });
}

export interface GwPayment { id: string; amount: number; status: string; method?: string }
export interface GwRefund { id: string; status: 'pending' | 'processed' | 'failed'; receipt?: string | null }
export interface GwInvoice { payment_id?: string | null; amount: number; amount_paid?: number; status: string }

/** Test mode stands in for Razorpay's read API, so the recovery paths run in tests without the network. */
export const testGateway = {
  payments: new Map<string, GwPayment>(),
  orderPayments: new Map<string, GwPayment[]>(),
  subscriptions: new Map<string, { paid_count: number; status: string }>(),
  invoices: new Map<string, GwInvoice[]>(),
  refunds: new Map<string, GwRefund[]>(),
};
const refundStatus = (s: string): GwRefund['status'] => (s === 'processed' ? 'processed' : s === 'failed' ? 'failed' : 'pending');

/** `receipt` (our refund's id) makes a repeat of the same refund a 400 at Razorpay, never a second refund. */
export async function refundPayment(paymentId: string, amount: number, notes: Record<string, string>, receipt: string): Promise<GwRefund> {
  if (isTest(paymentId) || !live()) {
    const r: GwRefund = { id: testId('rfnd'), status: 'processed', receipt };
    testGateway.refunds.set(paymentId, [...(testGateway.refunds.get(paymentId) ?? []), r]);
    return r;
  }
  const r = await rzp<{ id: string; status: string; receipt?: string | null }>(`/payments/${paymentId}/refund`, { amount, notes, receipt });
  return { id: r.id, status: refundStatus(r.status), receipt: r.receipt ?? null };
}

/** Read side, for verify and the hourly reconcile. Test mode reads `testGateway`; nothing there → null / empty. */
export async function fetchPayment(id: string): Promise<GwPayment | null> {
  if (isTest(id) || !live()) return testGateway.payments.get(id) ?? null;
  return rzp<GwPayment>(`/payments/${id}`);
}
export async function orderPayments(orderId: string): Promise<GwPayment[]> {
  if (isTest(orderId) || !live()) return testGateway.orderPayments.get(orderId) ?? [];
  return (await rzp<{ items: GwPayment[] }>(`/orders/${orderId}/payments`)).items;
}
export async function fetchSubscription(id: string): Promise<{ paid_count: number; status: string } | null> {
  if (isTest(id) || !live()) return testGateway.subscriptions.get(id) ?? null;
  return rzp<{ paid_count: number; status: string }>(`/subscriptions/${id}`);
}
export async function subscriptionInvoices(id: string): Promise<GwInvoice[]> {
  if (isTest(id) || !live()) return testGateway.invoices.get(id) ?? [];
  return (await rzp<{ items: GwInvoice[] }>(`/invoices?subscription_id=${id}&count=100`)).items;
}
export async function fetchRefunds(paymentId: string): Promise<GwRefund[]> {
  if (isTest(paymentId) || !live()) return testGateway.refunds.get(paymentId) ?? [];
  return (await rzp<{ items: { id: string; status: string; receipt?: string | null }[] }>(`/payments/${paymentId}/refunds?count=100`)).items.map((r) => ({ id: r.id, status: refundStatus(r.status), receipt: r.receipt ?? null }));
}

/** Checkout's handler signature: HMAC-SHA256(order_id|payment_id, key secret). */
export const paymentSignature = (orderId: string, paymentId: string) => hmac(env.RAZORPAY_KEY_SECRET ?? '', `${orderId}|${paymentId}`);
export const checkPayment = (orderId: string, paymentId: string, signature: string) => Boolean(env.RAZORPAY_KEY_SECRET) && same(paymentSignature(orderId, paymentId), signature);

/** Subscription Checkout signs payment_id|subscription_id — the other way round from orders. */
export const subscriptionSignature = (paymentId: string, subscriptionId: string) => hmac(env.RAZORPAY_KEY_SECRET ?? '', `${paymentId}|${subscriptionId}`);
export const checkSubscription = (paymentId: string, subscriptionId: string, signature: string) => Boolean(env.RAZORPAY_KEY_SECRET) && same(subscriptionSignature(paymentId, subscriptionId), signature);

/** Webhooks sign the raw body with the webhook secret. */
export const webhookSignature = (raw: string) => hmac(env.RAZORPAY_WEBHOOK_SECRET ?? '', raw);
export const checkWebhook = (raw: string, signature: string) => Boolean(env.RAZORPAY_WEBHOOK_SECRET) && same(webhookSignature(raw), signature);
