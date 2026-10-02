import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { AppError } from '../core/errors';

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

/** Razorpay Orders (PLAN §8): one-time orders, no auto-debit. Test mode makes local order ids; signatures stay real HMAC. */
export async function createOrder(amount: number, receipt: string, notes: Record<string, string>): Promise<string> {
  if (env.PAYMENTS_MODE === 'off') throw AppError.serviceUnavailable('Online payment isn’t set up yet. Please contact MedShop support.');
  if (env.PAYMENTS_MODE === 'test') return `order_test_${randomBytes(9).toString('hex')}`;
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID ?? ''}:${env.RAZORPAY_KEY_SECRET ?? ''}`).toString('base64')}` },
    body: JSON.stringify({ amount, currency: 'INR', receipt, notes }),
  });
  if (!res.ok) throw AppError.serviceUnavailable('The payment gateway did not answer. Please try again.');
  return ((await res.json()) as { id: string }).id;
}

/** Checkout's handler signature: HMAC-SHA256(order_id|payment_id, key secret). */
export const paymentSignature = (orderId: string, paymentId: string) => hmac(env.RAZORPAY_KEY_SECRET ?? '', `${orderId}|${paymentId}`);
export const checkPayment = (orderId: string, paymentId: string, signature: string) => Boolean(env.RAZORPAY_KEY_SECRET) && same(paymentSignature(orderId, paymentId), signature);

/** Webhooks sign the raw body with the webhook secret. */
export const webhookSignature = (raw: string) => hmac(env.RAZORPAY_WEBHOOK_SECRET ?? '', raw);
export const checkWebhook = (raw: string, signature: string) => Boolean(env.RAZORPAY_WEBHOOK_SECRET) && same(webhookSignature(raw), signature);
