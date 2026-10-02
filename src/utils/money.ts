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
