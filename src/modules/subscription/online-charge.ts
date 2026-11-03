import { rupees } from '../../core/export';
import { rhu } from '../../utils/money';
import { gateway } from './gateway';

export interface Charge { bps: number; amount: number; gst: number }

const gstIn = (paise: number) => paise - rhu(paise * 100, 118);
/** 200 → "2%", 250 → "2.5%". */
export const pctText = (bps: number) => `${String(bps / 100)}%`;

/** A price with the charge on top; each part keeps its own 18% GST inside, so every invoice line is whole. */
export function withCharge(price: number, bps: number) {
  const amount = Math.round((price * bps) / 10_000);
  const charge: Charge | undefined = amount > 0 ? { bps, amount, gst: gstIn(amount) } : undefined;
  return { amount: price + amount, gst: gstIn(price) + (charge?.gst ?? 0), charge };
}

/** The 18% GST inside an amount that may hold a charge — the same split `withCharge` made. */
export const gstOf = (amount: number, charge?: Charge | null) => gstIn(amount - (charge?.amount ?? 0)) + (charge?.gst ?? 0);

/** Every Razorpay payment (Checkout or autopay) adds the admin's charge; money taken by hand never does. */
export async function onlineCharge(price: number) {
  return withCharge(price, (await gateway()).chargeBps);
}

/** What the shop sees before paying: the price, the charge and the total. */
export const splitOf = (amount: number, charge?: Charge | null) => ({ price: amount - (charge?.amount ?? 0), charge: charge ? { pct: charge.bps / 100, amount: charge.amount } : null, amount });

/** The invoice line for the charge, after the item it was added to. */
export function chargeRow(n: number, charge: Charge | null | undefined, sac: string) {
  if (!charge) return [];
  return [{ cells: [String(n), `Online payment charge (${pctText(charge.bps)})`, sac, rupees(charge.amount - charge.gst), '18%', rupees(charge.amount)], sub: 'Added because this was paid online through Razorpay' }];
}
