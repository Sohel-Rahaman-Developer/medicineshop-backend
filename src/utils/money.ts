// Money is integer paise everywhere (PLAN §26).

/** num / den rounded half up, in integers only. */
export function rhu(num: number, den: number): number {
  if (num < 0) return -rhu(-num, den);
  return Math.floor((2 * num + den) / (2 * den));
}

/** Amount for a base-unit quantity priced per sale unit: Dolo ₹30 a strip of 15, 4 tablets → ₹8. */
export const amountFor = (pricePerSale: number, qtyBase: number, salePack: number) => rhu(pricePerSale * qtyBase, salePack);

/** ₹1,52,000.50 — Indian grouping, for messages only (screens format on their side). */
export const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Purchase rates are before GST: tax = taxable × rate% rounded half up; SGST takes the lower half (PLAN §14). */
export function gstExclusive(taxable: number, rate: number) {
  const tax = rhu(taxable * rate, 100);
  const sgst = Math.floor(tax / 2);
  return { taxable, rate, tax, sgst, cgst: tax - sgst, amount: taxable + tax };
}

/** Nearest rupee, with the visible round-off line (PLAN §26). */
export function roundRupee(amount: number) {
  const total = rhu(amount, 100) * 100;
  return { total, roundOff: total - amount };
}

/** Sales are MRP-inclusive: taxable = amount × 100 / (100 + rate) half up, tax = the rest (PLAN §14). */
export function gstInclusive(amount: number, rate: number) {
  const taxable = rate ? rhu(amount * 100, 100 + rate) : amount;
  const tax = amount - taxable;
  const sgst = Math.floor(tax / 2);
  return { amount, rate, taxable, tax, sgst, cgst: tax - sgst };
}

/** Splits a whole amount over weights exactly (largest remainder); the parts always add up to `total`. */
export function distribute(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum || !total) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) {
    const at = order[k % order.length]?.i ?? 0;
    out[at] = (out[at] ?? 0) + 1;
  }
  return out;
}
