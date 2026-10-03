import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { AppError } from '../core/errors';

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

async function rzp<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID ?? ''}:${env.RAZORPAY_KEY_SECRET ?? ''}`).toString('base64')}` },
    body: JSON.stringify(body),
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

export async function refundPayment(paymentId: string, amount: number, notes: Record<string, string>): Promise<{ id: string; status: 'pending' | 'processed' | 'failed' }> {
  if (isTest(paymentId) || !live()) return { id: testId('rfnd'), status: 'processed' };
  const r = await rzp<{ id: string; status: string }>(`/payments/${paymentId}/refund`, { amount, notes });
  return { id: r.id, status: r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'pending' };
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
