// Pure billing maths (PLAN §14, D56, D57), ported from sandbox domain.js D.price. Integer paise only.
import { amountFor, distribute, gstInclusive, rhu, roundRupee } from '../../utils/money';

/** pct is a percent with up to 2 decimals; flat is paise. */
export interface Discount {
  type: 'pct' | 'flat';
  value: number;
}

/** One batch's share of a cart line. `sell` is a typed amount for this part (D56), already split. */
export interface Part {
  mrp: number;
  qtyBase: number;
  salePack: number;
  gstRate: number;
  sell: number | null;
  discount: Discount | null;
}

const pctOf = (amount: number, pct: number) => rhu(amount * Math.round(pct * 100), 10_000);
const discOf = (gross: number, d: Discount | null) => (d && d.value > 0 ? Math.min(gross, d.type === 'pct' ? pctOf(gross, d.value) : d.value) : 0);

/** Splits a cart line over its FEFO parts: a typed price by MRP weight, a flat discount by gross, a % on each part. */
export function splitLine(parts: readonly { mrp: number; qtyBase: number }[], salePack: number, typed: number | null, discount: Discount | null) {
  const gross = parts.map((p) => amountFor(p.mrp, p.qtyBase, salePack));
  const sells = typed === null ? null : distribute(typed, gross.map((g) => g || 1));
  const flats = discount?.type === 'flat' ? distribute(Math.min(discount.value, gross.reduce((s, g) => s + g, 0)), gross) : null;
  return parts.map((_, i) => ({
    sell: sells ? (sells[i] ?? 0) : null,
    discount: sells ? null : flats ? { type: 'flat' as const, value: flats[i] ?? 0 } : discount,
  }));
}

export function priceSale(parts: readonly Part[], billDiscount: Discount | null, o: { roundOff: boolean; igst: boolean }) {
  const rows = parts.map((p) => {
    const gross = amountFor(p.mrp, p.qtyBase, p.salePack);
    // A typed price wins: under MRP it is a discount, over MRP it is the "above MRP" amount.
    if (p.sell !== null) return { gross, lineDiscount: Math.max(0, gross - p.sell), aboveMrp: Math.max(0, p.sell - gross) };
    return { gross, lineDiscount: discOf(gross, p.discount), aboveMrp: 0 };
  });
  const after = rows.map((r) => r.gross - r.lineDiscount + r.aboveMrp);
  const base = after.reduce((s, v) => s + v, 0);
  const billDisc = discOf(base, billDiscount);
  const shares = distribute(billDisc, after);
  const t = { subtotal: 0, lineDiscount: 0, billDiscount: billDisc, totalDiscount: 0, aboveMrp: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0, preRound: 0, roundOff: 0, grandTotal: 0, discountPercent: 0 };
  const lines = rows.map((r, i) => {
    const share = shares[i] ?? 0;
    const amount = (after[i] ?? 0) - share;
    const g = gstInclusive(amount, parts[i]?.gstRate ?? 0);
    const tax = o.igst ? { cgst: 0, sgst: 0, igst: g.tax } : { cgst: g.cgst, sgst: g.sgst, igst: 0 };
    t.subtotal += r.gross;
    t.lineDiscount += r.lineDiscount;
    t.aboveMrp += r.aboveMrp;
    t.taxable += g.taxable;
    t.cgst += tax.cgst;
    t.sgst += tax.sgst;
    t.igst += tax.igst;
    t.totalTax += g.tax;
    return { ...r, billShare: share, discount: r.lineDiscount + share, amount, taxable: g.taxable, tax: g.tax, ...tax };
  });
  t.totalDiscount = t.lineDiscount + billDisc;
  t.preRound = t.subtotal - t.totalDiscount + t.aboveMrp;
  const r = o.roundOff ? roundRupee(t.preRound) : { total: t.preRound, roundOff: 0 };
  t.grandTotal = r.total;
  t.roundOff = r.roundOff;
  // Two decimals, for the discount register and the shop limit (D43).
  t.discountPercent = t.subtotal ? Math.round((t.totalDiscount * 10_000) / t.subtotal) / 100 : 0;
  return { lines, ...t };
}

/** HSN-wise GST summary printed on the bill — sums of the lines, never recomputed. */
export function hsnSummary(lines: readonly { hsn: string; gstRate: number; taxableAmount: number; cgst: number; sgst: number; igst: number }[]) {
  const m = new Map<string, { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of lines) {
    const k = `${l.hsn}|${String(l.gstRate)}`;
    const r = m.get(k) ?? { hsn: l.hsn, rate: l.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.taxableAmount;
    r.cgst += l.cgst;
    r.sgst += l.sgst;
    r.igst += l.igst;
    m.set(k, r);
  }
  return [...m.values()];
}

/** The lowest price (D57) for a part, in paise; null when the batch has none. */
export const floorOf = (minPrice: number | null | undefined, qtyBase: number, salePack: number) => (minPrice ? amountFor(minPrice, qtyBase, salePack) : null);

/** The bill QR (PLAN §35.7): number, IST day and total in paise — the return screen opens the bill from it. */
export const qrText = (billNumber: string, billDay: string, grandTotal: number) => `${billNumber}|${billDay}|${String(grandTotal)}`;

/** A return's share of a bill line (PLAN §15): cumulative rounding, so returning it all gives back exactly the line. */
export function returnShare(l: { quantityInBase: number; totalAmount: number; cgst: number; sgst: number; igst: number }, already: number, qty: number) {
  const part = (v: number) => rhu(v * (already + qty), l.quantityInBase) - rhu(v * already, l.quantityInBase);
  const amount = part(l.totalAmount);
  const cgst = part(l.cgst);
  const sgst = part(l.sgst);
  const igst = part(l.igst);
  return { amount, cgst, sgst, igst, tax: cgst + sgst + igst, taxable: amount - cgst - sgst - igst };
}

/** "2 STRIP + 3 TABLET" from base units, as printed on the bill. */
export function packLabel(base: number, pack: number, sale: string, baseUnit: string) {
  if (pack <= 1) return `${String(base)} ${sale}`;
  const full = Math.floor(base / pack);
  const loose = base % pack;
  return [full ? `${String(full)} ${sale}` : '', loose ? `${String(loose)} ${baseUnit}` : ''].filter(Boolean).join(' + ');
}
