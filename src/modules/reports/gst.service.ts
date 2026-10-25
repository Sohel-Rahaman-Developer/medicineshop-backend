import type { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { PurchaseModel, PurchaseReturnModel } from '../purchases/purchase.model';
import { SaleModel } from '../sales/sale.model';
import { StockTransferModel } from '../transfers/transfer.model';
import { gstPurchases, gstSales, shopsOf, splitTax } from './catalog';

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;

/** S62: one month for the CA — sales HSN-wise, rate-wise, purchases GSTIN-wise, B2B bills and the net. A guide, not a filing.
 * v1.25.3: `shops` adds up every shop on one GSTIN; tax invoices between the owner's shops count like sales and purchases. */
export async function gstMonth(t: TenantContext, month: string, now = new Date(), shops?: Types.ObjectId[]) {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - IST);
  const next = new Date(Date.UTC(y, m, 1) - IST);
  const to = new Date(Math.min(next.getTime(), now.getTime() + DAY) - DAY);
  const p = { from, to, month, shops };
  const sid = shopsOf(t, p);
  const inMonth = { $gte: from, $lt: next };
  const [sales, purchases, purRates, trRates, credit, b2b, trOut] = await Promise.all([
    gstSales(t, p),
    gstPurchases(t, p),
    PurchaseModel.aggregate<{ _id: number; taxable: number; tax: number }>([{ $match: { shopId: sid, status: 'active', invoiceDate: inMonth } }, { $unwind: '$lines' }, { $group: { _id: '$lines.gstRate', taxable: { $sum: '$lines.taxableAmount' }, tax: { $sum: { $add: ['$lines.cgst', '$lines.sgst'] } } } }]),
    StockTransferModel.aggregate<{ _id: number; taxable: number; tax: number }>([{ $match: { toShopId: sid, kind: 'invoice', status: 'received', sentAt: inMonth } }, { $unwind: '$lines' }, { $group: { _id: '$lines.gstRate', taxable: { $sum: '$lines.value' }, tax: { $sum: '$lines.tax' } } }]),
    PurchaseReturnModel.aggregate<{ tax: number; n: number }>([{ $match: { shopId: sid, returnDate: inMonth } }, { $group: { _id: null, tax: { $sum: '$tax' }, n: { $sum: 1 } } }]),
    SaleModel.find({ shopId: sid, billDate: inMonth, status: { $ne: 'cancelled' }, buyerGstin: { $nin: [null, ''] } }).sort({ billDate: 1 }).select('billNumber billDate buyerName buyerGstin customerName taxableAmount cgst sgst igst grandTotal').lean<{ _id: unknown; billNumber: string; billDate: Date; buyerName?: string; buyerGstin: string; customerName: string; taxableAmount: number; cgst: number; sgst: number; igst: number; grandTotal: number }[]>(),
    StockTransferModel.find({ fromShopId: sid, kind: 'invoice', status: { $ne: 'cancelled' }, sentAt: inMonth }).sort({ sentAt: 1 }).select('number sentAt to from value tax total').lean(),
  ]);
  const rates = new Map<number, { rate: number; salesTaxable: number; salesTax: number; purTaxable: number; purTax: number }>();
  const at = (r: number) => rates.get(r) ?? { rate: r, salesTaxable: 0, salesTax: 0, purTaxable: 0, purTax: 0 };
  for (const s of sales) rates.set(s.rate, { ...at(s.rate), salesTaxable: at(s.rate).salesTaxable + s.taxable, salesTax: at(s.rate).salesTax + s.cgst + s.sgst + s.igst });
  for (const x of [...purRates, ...trRates]) rates.set(x._id, { ...at(x._id), purTaxable: at(x._id).purTaxable + x.taxable, purTax: at(x._id).purTax + x.tax });
  const outTax = sales.reduce((a, s) => a + s.cgst + s.sgst + s.igst, 0);
  const purchaseTax = purchases.reduce((a, s) => a + s.cgst + s.sgst + s.igst, 0);
  const bills = [
    ...b2b.map((s) => ({ billNumber: s.billNumber, billDate: s.billDate, buyer: s.buyerName || s.customerName, gstin: s.buyerGstin, taxable: s.taxableAmount, cgst: s.cgst, sgst: s.sgst, igst: s.igst, total: s.grandTotal })),
    ...trOut.map((x) => ({ billNumber: x.number, billDate: x.sentAt, buyer: x.to.name ?? '', gstin: x.to.gstin ?? '', taxable: x.value, ...splitTax(x.tax, x.from.stateCode === x.to.stateCode), total: x.total })),
  ].sort((a, b) => a.billDate.getTime() - b.billDate.getTime());
  const creditTax = credit[0]?.tax ?? 0;
  const inTax = purchaseTax - creditTax;
  return {
    month,
    from: istIsoDay(from),
    to: istIsoDay(to),
    sales,
    purchases,
    rates: [...rates.values()].sort((a, b) => a.rate - b.rate),
    b2b: bills,
    salesTaxable: sales.reduce((a, s) => a + s.taxable, 0),
    outTax,
    purchaseTax,
    creditTax,
    creditNotes: credit[0]?.n ?? 0,
    inTax,
    net: outTax - inTax,
  };
}
