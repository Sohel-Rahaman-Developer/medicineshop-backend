import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { PurchaseModel, PurchaseReturnModel } from '../purchases/purchase.model';
import { SaleModel } from '../sales/sale.model';
import { gstPurchases, gstSales } from './catalog';

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;

/** S62: one month for the CA — sales HSN-wise, rate-wise, purchases GSTIN-wise, B2B bills and the net. A guide, not a filing. */
export async function gstMonth(t: TenantContext, month: string, now = new Date()) {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - IST);
  const next = new Date(Date.UTC(y, m, 1) - IST);
  const to = new Date(Math.min(next.getTime(), now.getTime() + DAY) - DAY);
  const p = { from, to, month };
  const inMonth = { $gte: from, $lt: next };
  const [sales, purchases, purRates, credit, b2b] = await Promise.all([
    gstSales(t, p),
    gstPurchases(t, p),
    PurchaseModel.aggregate<{ _id: number; taxable: number; tax: number }>([{ $match: { shopId: t.shopId, status: 'active', invoiceDate: inMonth } }, { $unwind: '$lines' }, { $group: { _id: '$lines.gstRate', taxable: { $sum: '$lines.taxableAmount' }, tax: { $sum: { $add: ['$lines.cgst', '$lines.sgst'] } } } }]),
    PurchaseReturnModel.aggregate<{ tax: number; n: number }>([{ $match: { shopId: t.shopId, returnDate: inMonth } }, { $group: { _id: null, tax: { $sum: '$tax' }, n: { $sum: 1 } } }]),
    SaleModel.find({ shopId: t.shopId, billDate: inMonth, status: { $ne: 'cancelled' }, buyerGstin: { $nin: [null, ''] } }).sort({ billDate: 1 }).select('billNumber billDate buyerName buyerGstin customerName taxableAmount cgst sgst igst grandTotal').lean<{ _id: unknown; billNumber: string; billDate: Date; buyerName?: string; buyerGstin: string; customerName: string; taxableAmount: number; cgst: number; sgst: number; igst: number; grandTotal: number }[]>(),
  ]);
  const rates = new Map<number, { rate: number; salesTaxable: number; salesTax: number; purTaxable: number; purTax: number }>();
  const at = (r: number) => rates.get(r) ?? { rate: r, salesTaxable: 0, salesTax: 0, purTaxable: 0, purTax: 0 };
  for (const s of sales) rates.set(s.rate, { ...at(s.rate), salesTaxable: at(s.rate).salesTaxable + s.taxable, salesTax: at(s.rate).salesTax + s.cgst + s.sgst + s.igst });
  for (const x of purRates) rates.set(x._id, { ...at(x._id), purTaxable: at(x._id).purTaxable + x.taxable, purTax: at(x._id).purTax + x.tax });
  const outTax = sales.reduce((a, s) => a + s.cgst + s.sgst + s.igst, 0);
  const purchaseTax = purchases.reduce((a, s) => a + s.cgst + s.sgst, 0);
  const creditTax = credit[0]?.tax ?? 0;
  const inTax = purchaseTax - creditTax;
  return {
    month,
    from: istIsoDay(from),
    to: istIsoDay(to),
    sales,
    purchases,
    rates: [...rates.values()].sort((a, b) => a.rate - b.rate),
    b2b: b2b.map((s) => ({ billNumber: s.billNumber, billDate: s.billDate, buyer: s.buyerName || s.customerName, gstin: s.buyerGstin, taxable: s.taxableAmount, cgst: s.cgst, sgst: s.sgst, igst: s.igst, total: s.grandTotal })),
    salesTaxable: sales.reduce((a, s) => a + s.taxable, 0),
    outTax,
    purchaseTax,
    creditTax,
    creditNotes: credit[0]?.n ?? 0,
    inTax,
    net: outTax - inTax,
  };
}
