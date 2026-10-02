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
