// Pure stock rules, ported from sandbox domain.js (PLAN §9, §12, D36). No database here, so unit tests cover them.
import { amountFor, rhu } from '../../utils/money';

export type Bucket = 'sellable' | 'expired' | 'blocked';
export type BatchStatus = 'active' | 'blocked' | 'returned';
export type StockStatus = 'ok' | 'low' | 'out';
export type ExpiryBucket = 'expired' | 'd30' | 'd60' | 'd90' | 'later';

export interface BatchLike {
  _id: { toString(): string };
  quantity: number;
  status: BatchStatus;
  expiryDate: Date;
  receivedAt: Date;
  costPerBaseUnit: number;
  mrp: number;
}

const DAY = 24 * 60 * 60 * 1000;
/** Sorts products without sellable stock after every real expiry date. */
export const NO_EXPIRY = new Date('9999-12-31T00:00:00.000Z');
/** D59: a product without expiry keeps NO_EXPIRY on its batches, so every date range skips it; the API sends null. */
export const hasExpiry = (d: Date) => d.getTime() < NO_EXPIRY.getTime();

/** D59: what a received line is stored as. No-expiry products take NO_EXPIRY; a non-medicine without a batch number gets the day's lot. */
export function lotOf(p: { noExpiry?: boolean | null; scheduleType: string }, batchNumber: string, expiry: Date | undefined, lotDay: string): { batchNumber: string; expiry: Date } | { field: 'expiry' | 'batchNumber'; message: string } {
  const exp = p.noExpiry ? NO_EXPIRY : expiry;
  if (!exp) return { field: 'expiry', message: 'Expiry is required' };
  if (batchNumber) return { batchNumber, expiry: exp };
  if (p.scheduleType !== 'NON_DRUG') return { field: 'batchNumber', message: 'Batch number is required' };
  return { batchNumber: `LOT-${lotDay}`, expiry: exp };
}

/** Each batch counts in one bucket only: blocked > expired > sellable. */
export function bucketOf(b: Pick<BatchLike, 'quantity' | 'status' | 'expiryDate'>, now: Date): Bucket | null {
  if (b.quantity <= 0 || b.status === 'returned') return null;
  if (b.status === 'blocked') return 'blocked';
  if (b.expiryDate.getTime() < now.getTime()) return 'expired';
  return 'sellable';
}

/** Sellable batches, first to expire first; same expiry → the one that came in first. */
export function fefo<T extends BatchLike>(batches: readonly T[], now: Date): T[] {
  return batches
    .filter((b) => bucketOf(b, now) === 'sellable')
    .sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime() || a.receivedAt.getTime() - b.receivedAt.getTime() || a._id.toString().localeCompare(b._id.toString()));
}

/** FEFO split of a base-unit quantity across batches; `first` is a batch the user picked by hand. */
export function allocate<T extends BatchLike>(batches: readonly T[], qtyBase: number, now: Date, first?: string) {
  const order = fefo(batches, now);
  if (first) {
    const i = order.findIndex((b) => b._id.toString() === first);
    if (i > 0) order.unshift(...order.splice(i, 1));
  }
  const parts: { batch: T; qty: number }[] = [];
  let left = qtyBase;
  for (const b of order) {
    if (left <= 0) break;
    const take = Math.min(left, b.quantity);
    if (take > 0) {
      parts.push({ batch: b, qty: take });
      left -= take;
    }
  }
  return { parts, short: left };
}

export interface StockRollup {
  onHand: number;
  sellable: number;
  expired: number;
  blocked: number;
  value: number;
  mrpValue: number;
  batches: number;
  nextExpiry: Date | null;
  expirySort: Date;
  validUntil: Date;
  status: StockStatus;
}

export const statusOf = (sellable: number, reorderLevel: number): StockStatus => (sellable <= 0 ? 'out' : sellable <= reorderLevel ? 'low' : 'ok');

/** Product totals from its batches. Valid until the next sellable batch expires (PLAN §21.4 rollup). */
export function rollup(batches: readonly BatchLike[], p: { reorderLevel: number; salePack: number }, now: Date): StockRollup {
  const r = { onHand: 0, sellable: 0, expired: 0, blocked: 0, value: 0, mrpValue: 0, batches: 0 };
  let next: Date | null = null;
  for (const b of batches) {
    const k = bucketOf(b, now);
    if (!k) continue;
    r[k] += b.quantity;
    r.onHand += b.quantity;
    r.batches += 1;
    r.value += b.quantity * b.costPerBaseUnit;
    r.mrpValue += amountFor(b.mrp, b.quantity, p.salePack);
    if (k === 'sellable' && hasExpiry(b.expiryDate) && (!next || b.expiryDate < next)) next = b.expiryDate;
  }
  return { ...r, nextExpiry: next, expirySort: next ?? NO_EXPIRY, validUntil: next ?? NO_EXPIRY, status: statusOf(r.sellable, p.reorderLevel) };
}

export const daysLeft = (expiry: Date, now: Date) => Math.ceil((expiry.getTime() - now.getTime()) / DAY);
/** For the API: null for a batch without expiry (D59). */
export const daysLeftOut = (expiry: Date, now: Date) => (hasExpiry(expiry) ? daysLeft(expiry, now) : null);

/** Expiry centre tiles: expired, then 0–30, 31–60, 61–90 days (blocked batches stay out). */
export function expiryBucketOf(b: Pick<BatchLike, 'quantity' | 'status' | 'expiryDate'>, now: Date): ExpiryBucket | null {
  const k = bucketOf(b, now);
  if (k === 'expired') return 'expired';
  if (k !== 'sellable') return null;
  const d = daysLeft(b.expiryDate, now);
  return d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : 'later';
}

/** Expiry bucket bounds as dates, for indexed batch queries. */
export function expiryRange(bucket: ExpiryBucket, now: Date): { from?: Date; to?: Date } {
  const at = (days: number) => new Date(now.getTime() + days * DAY);
  if (bucket === 'expired') return { to: now };
  if (bucket === 'd30') return { from: now, to: at(30) };
  if (bucket === 'd60') return { from: at(30), to: at(60) };
  if (bucket === 'd90') return { from: at(60), to: at(90) };
  return { from: at(90) };
}

export interface ReorderSuggestion {
  need: number;
  saleUnits: number;
  target: number;
  basis: 'sales' | 'reorderQty' | 'none';
}

/** Target days of sales minus sellable stock; with no sales to learn from, the reorder quantity. */
export function suggestReorder(p: { reorderQuantity: number; salePack: number }, sellable: number, perDay: number, targetDays: number): ReorderSuggestion {
  if (!perDay) {
    if (!p.reorderQuantity) return { need: 0, saleUnits: 0, target: 0, basis: 'none' };
    const need = Math.max(0, p.reorderQuantity - sellable);
    return { need, saleUnits: Math.ceil(need / p.salePack), target: p.reorderQuantity, basis: 'reorderQty' };
  }
  const target = Math.ceil(targetDays * perDay);
  const need = Math.max(0, target - sellable);
  return { need, saleUnits: Math.ceil(need / p.salePack), target, basis: 'sales' };
}

/** Landing cost per base unit when stock is merged into a batch: weighted by quantity. */
export const mergedCost = (oldQty: number, oldCost: number, addQty: number, addCost: number) =>
  oldQty + addQty > 0 ? rhu(oldQty * oldCost + addQty * addCost, oldQty + addQty) : addCost;
