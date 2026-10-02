import { gstExclusive, rhu, roundRupee } from '../../utils/money';

export interface LineMath {
  /** In `unit`, which holds `conv` base units. */
  quantity: number;
  freeQuantity: number;
  /** Paise per `unit`, before GST. */
  rate: number;
  /** Up to two decimals: 7.5 = 7.5 %. */
  discountPercent: number;
  gstRate: number;
  conv: number;
}

/** One invoice line as PLAN §13 works it out; free goods lower the cost of every unit, GST is not cost. */
export function purchaseLine(l: LineMath) {
  const gross = l.quantity * l.rate;
  const discount = rhu(gross * Math.round(l.discountPercent * 100), 10_000);
  const taxable = gross - discount;
  const g = gstExclusive(taxable, l.gstRate);
  const units = l.quantity + l.freeQuantity;
  const baseQty = units * l.conv;
  return {
    gross,
    discount,
    taxable,
    tax: g.tax,
    cgst: g.cgst,
    sgst: g.sgst,
    total: g.amount,
    baseQty,
    freeBase: l.freeQuantity * l.conv,
    landingPerUnit: units ? rhu(taxable, units) : 0,
    costPerBaseUnit: baseQty ? rhu(taxable, baseQty) : 0,
  };
}

export type LineCalc = ReturnType<typeof purchaseLine>;

/** Tax is summed line by line, then the whole invoice rounds to the rupee. */
export function purchaseTotals(lines: readonly Pick<LineCalc, 'gross' | 'discount' | 'taxable' | 'cgst' | 'sgst'>[]) {
  const t = { subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0 };
  for (const l of lines) {
    t.subtotal += l.gross;
    t.discount += l.discount;
    t.taxable += l.taxable;
    t.cgst += l.cgst;
    t.sgst += l.sgst;
  }
  const r = roundRupee(t.taxable + t.cgst + t.sgst);
  return { ...t, roundOff: r.roundOff, grandTotal: r.total };
}

export interface OpenInvoice {
  id: string;
  dueAmount: number;
  invoiceDate: Date;
}

/** Spreads a credit over open invoices: the preferred one first, then the oldest. What is left is advance. */
export function applyCredit(open: readonly OpenInvoice[], amount: number, preferId?: string) {
  const order = [...open].sort((a, b) => Number(b.id === preferId) - Number(a.id === preferId) || a.invoiceDate.getTime() - b.invoiceDate.getTime() || a.id.localeCompare(b.id));
  const applied: { id: string; amount: number }[] = [];
  let left = amount;
  for (const inv of order) {
    if (left <= 0) break;
    const take = Math.min(left, inv.dueAmount);
    if (take <= 0) continue;
    applied.push({ id: inv.id, amount: take });
    left -= take;
  }
  return { applied, left };
}

export const paymentStatusOf = (grandTotal: number, dueAmount: number) => (dueAmount <= 0 ? 'paid' : dueAmount < grandTotal ? 'partial' : 'unpaid');
