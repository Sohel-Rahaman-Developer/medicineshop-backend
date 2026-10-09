// S61 report centre (PLAN §20, sandbox insights.js): every report is built on the server from ledgers and bill snapshots.
import { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { fromBase, type Units } from '../../utils/units';
import { CustomerModel } from '../customers/customer.model';
import { ExpenseModel } from '../expenses/expense.model';
import { LoyaltyModel } from '../loyalty/loyalty.model';
import { ProductModel } from '../products/product.model';
import { PurchaseModel, PurchaseReturnModel, SupplierPaymentModel } from '../purchases/purchase.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import { ShopModel } from '../shops/shop.model';
import { BatchModel } from '../stock/batch.model';
import { expiryRange, NO_EXPIRY } from '../stock/stock.domain';
import { MovementModel } from '../stock/movement.model';
import { SupplierModel } from '../suppliers/supplier.model';
import { daybook, pnl, pnlByDay } from './pnl.service';

const DAY = 24 * 60 * 60 * 1000;
const MAX = 5000;

export type ColKind = 'text' | 'num' | 'money' | 'date' | 'datetime' | 'pct';
export interface Col {
  key: string;
  label: string;
  kind: ColKind;
}
export type Cell = string | number | null;
/** `__total: 1` marks the total row. */
export type Row = Record<string, Cell>;
export type RangeKind = 'range' | 'none' | 'month';
export interface Params {
  from: Date;
  to: Date;
  month: string;
}

export interface Report {
  key: string;
  group: 'Sales' | 'Stock' | 'Purchase' | 'Customers' | 'Tax & compliance' | 'Money';
  name: string;
  range: RangeKind;
  note?: string;
  cols: Col[];
  rows: (t: TenantContext, p: Params) => Promise<Row[]>;
}

const c = (key: string, label: string, kind: ColKind = 'text'): Col => ({ key, label, kind });
const end = (p: Params) => new Date(p.to.getTime() + DAY);
const inRange = (p: Params) => ({ $gte: p.from, $lt: end(p) });
const live = { status: { $ne: 'cancelled' as const } };
const pct = (part: number, whole: number) => (whole ? Math.round((part * 10_000) / whole) / 100 : 0);
const sum = <T>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
const totalRow = (rows: Row[], label: Record<string, Cell>, keys: string[]): Row[] => (rows.length ? [...rows, { ...label, ...Object.fromEntries(keys.map((k) => [k, sum(rows, (r) => Number(r[k] ?? 0))])), __total: 1 }] : rows);
const mrpOf = (mrp: number, qty: number, salePack: number) => Math.floor((mrp * qty) / salePack + 0.5);
const exp = (d: Date | null | undefined) => (d && d.getTime() < NO_EXPIRY.getTime() ? istIsoDay(d).slice(0, 7) : '—');

async function productUnits(t: TenantContext, ids: Types.ObjectId[]) {
  const rows = await ProductModel.find({ shopId: t.shopId, _id: { $in: ids } }).select('name units categoryId').lean();
  return new Map(rows.map((p) => [String(p._id), p]));
}

const REPORTS: Report[] = [
  {
    key: 'sales-register',
    group: 'Sales',
    name: 'Sales register',
    range: 'range',
    cols: [c('bill', 'Bill'), c('date', 'Date', 'datetime'), c('customer', 'Customer'), c('items', 'Items', 'num'), c('discount', 'Discount', 'money'), c('tax', 'Tax', 'money'), c('total', 'Total', 'money'), c('mode', 'Mode'), c('status', 'Status'), c('by', 'By')],
    rows: async (t, p) => {
      const s = await SaleModel.find({ shopId: t.shopId, billDate: inRange(p) }).sort({ billDate: -1 }).limit(MAX).select('billNumber billDate customerName lines totalDiscount totalTax grandTotal paymentMode status createdByName').lean();
      const rows = s.map((x) => ({ bill: x.billNumber, date: x.billDate.toISOString(), customer: x.customerName, items: x.lines.length, discount: x.totalDiscount, tax: x.totalTax, total: x.grandTotal, mode: x.paymentMode, status: x.status, by: x.createdByName }));
      return totalRow(rows.filter((r) => r.status !== 'cancelled'), { bill: 'Total (not cancelled)' }, ['items', 'discount', 'tax', 'total']).concat(rows.filter((r) => r.status === 'cancelled'));
    },
  },
  {
    key: 'sales-summary',
    group: 'Sales',
    name: 'Sales summary (day-wise)',
    range: 'range',
    note: 'Revenue is ex-GST and net of returns; cost is each batch’s landing cost.',
    cols: [c('day', 'Day', 'date'), c('bills', 'Bills', 'num'), c('revenue', 'Revenue', 'money'), c('cost', 'Cost', 'money'), c('profit', 'Profit', 'money'), c('margin', 'Margin %', 'pct')],
    rows: async (t, p) => {
      const rows: Row[] = (await pnlByDay(t, p.from, p.to))
        .filter((x) => x.bills || x.returns)
        .map((x) => ({ day: x.day, bills: x.bills, revenue: x.revenue, cost: x.cogs, profit: x.gross, margin: x.grossPct }))
        .reverse();
      const tot = totalRow(rows, { day: 'Total' }, ['bills', 'revenue', 'cost', 'profit']);
      const last = tot.at(-1);
      if (last?.__total) last.margin = pct(Number(last.profit), Number(last.revenue));
      return tot;
    },
  },
  {
    key: 'product-sales',
    group: 'Sales',
    name: 'Product-wise sales',
    range: 'range',
    note: 'Bills in the range, before returns.',
    cols: [c('product', 'Product'), c('qty', 'Qty sold'), c('revenue', 'Revenue (ex-GST)', 'money'), c('cost', 'Cost', 'money'), c('profit', 'Profit', 'money'), c('margin', 'Margin %', 'pct')],
    rows: async (t, p) => {
      const g = await SaleModel.aggregate<{ _id: Types.ObjectId; name: string; qty: number; revenue: number; cost: number }>([
        { $match: { shopId: t.shopId, billDate: inRange(p), ...live } },
        { $unwind: '$lines' },
        { $group: { _id: '$lines.productId', name: { $first: '$lines.productName' }, qty: { $sum: '$lines.quantityInBase' }, revenue: { $sum: '$lines.taxableAmount' }, cost: { $sum: '$lines.lineCost' } } },
        { $sort: { revenue: -1 } },
        { $limit: MAX },
      ]);
      const units = await productUnits(t, g.map((x) => x._id));
      const rows = g.map((x) => {
        const u = units.get(String(x._id))?.units as Units | undefined;
        return { product: x.name, qty: u ? fromBase(x.qty, u) : String(x.qty), revenue: x.revenue, cost: x.cost, profit: x.revenue - x.cost, margin: pct(x.revenue - x.cost, x.revenue) };
      });
      return totalRow(rows, { product: 'Total', qty: '' }, ['revenue', 'cost', 'profit']);
    },
  },
  {
    key: 'batch-sales',
    group: 'Sales',
    name: 'Batch-wise sales',
    range: 'range',
    cols: [c('product', 'Product'), c('batch', 'Batch'), c('expiry', 'Expiry'), c('qty', 'Qty (base)', 'num'), c('revenue', 'Revenue (ex-GST)', 'money'), c('cost', 'Cost', 'money'), c('profit', 'Profit', 'money')],
    rows: async (t, p) => {
      const g = await SaleModel.aggregate<{ _id: Types.ObjectId; name: string; batch: string; expiry: Date; qty: number; revenue: number; cost: number }>([
        { $match: { shopId: t.shopId, billDate: inRange(p), ...live } },
        { $unwind: '$lines' },
        { $group: { _id: '$lines.batchId', name: { $first: '$lines.productName' }, batch: { $first: '$lines.batchNumber' }, expiry: { $first: '$lines.expiryDate' }, qty: { $sum: '$lines.quantityInBase' }, revenue: { $sum: '$lines.taxableAmount' }, cost: { $sum: '$lines.lineCost' } } },
        { $sort: { name: 1, expiry: 1 } },
        { $limit: MAX },
      ]);
      return totalRow(g.map((x) => ({ product: x.name, batch: x.batch, expiry: exp(x.expiry), qty: x.qty, revenue: x.revenue, cost: x.cost, profit: x.revenue - x.cost })), { product: 'Total' }, ['revenue', 'cost', 'profit']);
    },
  },
  {
    key: 'staff',
    group: 'Sales',
    name: 'Staff performance',
    range: 'range',
    cols: [c('staff', 'Staff'), c('bills', 'Bills', 'num'), c('value', 'Sales', 'money'), c('avg', 'Avg bill', 'money'), c('discount', 'Discount given', 'money')],
    rows: async (t, p) => {
      const g = await SaleModel.aggregate<{ _id: Types.ObjectId; name: string; bills: number; value: number; discount: number }>([
        { $match: { shopId: t.shopId, billDate: inRange(p), ...live } },
        { $group: { _id: '$createdBy', name: { $first: '$createdByName' }, bills: { $sum: 1 }, value: { $sum: '$grandTotal' }, discount: { $sum: '$totalDiscount' } } },
        { $sort: { value: -1 } },
      ]);
      return totalRow(g.map((x) => ({ staff: x.name, bills: x.bills, value: x.value, avg: x.bills ? Math.round(x.value / x.bills) : 0, discount: x.discount })), { staff: 'Total', avg: null }, ['bills', 'value', 'discount']);
    },
  },
  {
    key: 'discounts',
    group: 'Sales',
    name: 'Discount register',
    range: 'range',
    note: 'Every bill not sold at MRP — below it (line, bill and typed-price discounts together) or above it. “Above limit” = more than the shop’s maximum at the time; it was allowed, logged and the owner was told. Points are not a discount.',
    cols: [c('date', 'Date', 'datetime'), c('bill', 'Bill'), c('by', 'Staff'), c('customer', 'Customer'), c('mrp', 'MRP value', 'money'), c('discount', 'Discount', 'money'), c('pct', '%', 'pct'), c('over', 'Above limit'), c('above', 'Above MRP', 'money'), c('total', 'Bill total', 'money')],
    rows: async (t, p) => {
      const s = await SaleModel.find({ shopId: t.shopId, billDate: inRange(p), ...live, $or: [{ totalDiscount: { $gt: 0 } }, { aboveMrpAmount: { $gt: 0 } }] }).sort({ billDate: -1 }).limit(MAX).select('billNumber billDate createdByName customerName subtotal totalDiscount discountPercent discountAboveLimit aboveMrpAmount grandTotal').lean();
      const rows = s.map((x) => ({ date: x.billDate.toISOString(), bill: x.billNumber, by: x.createdByName, customer: x.customerName, mrp: x.subtotal, discount: x.totalDiscount, pct: x.discountPercent, over: x.discountAboveLimit ? 'Yes' : '', above: x.aboveMrpAmount, total: x.grandTotal }));
      const tot = totalRow(rows, { date: null, bill: `${String(rows.length)} bills`, over: `${String(rows.filter((r) => r.over).length)} above` }, ['mrp', 'discount', 'above', 'total']);
      const last = tot.at(-1);
      if (last?.__total) last.pct = pct(Number(last.discount), Number(last.mrp));
      return tot;
    },
  },
  {
    key: 'stock-on-hand',
    group: 'Stock',
    name: 'Stock on hand',
    range: 'none',
    cols: [c('product', 'Product'), c('batch', 'Batch'), c('expiry', 'Expiry'), c('qty', 'Qty'), c('cost', 'Cost value', 'money'), c('mrp', 'MRP value', 'money'), c('rack', 'Rack')],
    rows: async (t) => {
      const b = await BatchModel.find({ shopId: t.shopId, status: 'active', quantity: { $gt: 0 } }).sort({ expiryDate: 1 }).limit(MAX).select('productId batchNumber expiryDate quantity costPerBaseUnit mrp salePack rack').lean();
      const units = await productUnits(t, [...new Set(b.map((x) => String(x.productId)))].map((id) => new Types.ObjectId(id)));
      const rows = b.map((x) => {
        const p = units.get(String(x.productId));
        return { product: p?.name ?? '', batch: x.batchNumber, expiry: exp(x.expiryDate), qty: p ? fromBase(x.quantity, p.units as Units) : String(x.quantity), cost: x.quantity * x.costPerBaseUnit, mrp: mrpOf(x.mrp, x.quantity, x.salePack), rack: x.rack };
      });
      return totalRow(rows.sort((a, z) => a.product.localeCompare(z.product)), { product: 'Total', qty: '' }, ['cost', 'mrp']);
    },
  },
  {
    key: 'valuation',
    group: 'Stock',
    name: 'Stock valuation',
    range: 'none',
    note: 'Sellable stock today, by category. Potential profit = MRP value − cost value (before GST and discounts).',
    cols: [c('category', 'Category'), c('cost', 'Cost value', 'money'), c('mrp', 'MRP value', 'money'), c('potential', 'Potential profit', 'money')],
    rows: async (t) => {
      const g = await BatchModel.aggregate<{ _id: string; cost: number; mrp: number }>([
        { $match: { shopId: t.shopId, status: 'active', quantity: { $gt: 0 }, expiryDate: { $gte: new Date() } } },
        // Summed per product, then per category, so the lookups run once per product and category, not per batch.
        { $group: { _id: '$productId', cost: { $sum: { $multiply: ['$quantity', '$costPerBaseUnit'] } }, mrp: { $sum: { $floor: { $add: [{ $divide: [{ $multiply: ['$mrp', '$quantity'] }, '$salePack'] }, 0.5] } } } } },
        { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'p', pipeline: [{ $project: { categoryId: 1 } }] } },
        { $group: { _id: { $first: '$p.categoryId' }, cost: { $sum: '$cost' }, mrp: { $sum: '$mrp' } } },
        { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'c', pipeline: [{ $project: { name: 1 } }] } },
        { $group: { _id: { $ifNull: [{ $first: '$c.name' }, 'Other'] }, cost: { $sum: '$cost' }, mrp: { $sum: '$mrp' } } },
        { $sort: { cost: -1 } },
      ]);
      return totalRow(g.map((x) => ({ category: x._id, cost: x.cost, mrp: x.mrp, potential: x.mrp - x.cost })), { category: 'Total' }, ['cost', 'mrp', 'potential']);
    },
  },
  {
    key: 'expiry',
    group: 'Stock',
    name: 'Expiry report (next 90 days)',
    range: 'none',
    cols: [c('product', 'Product'), c('batch', 'Batch'), c('expiry', 'Expiry', 'date'), c('days', 'Days left', 'num'), c('qty', 'Qty'), c('value', 'Cost value', 'money')],
    rows: async (t) => batchRows(t, 'soon'),
  },
  {
    key: 'expired',
    group: 'Stock',
    name: 'Expired stock',
    range: 'none',
    cols: [c('product', 'Product'), c('batch', 'Batch'), c('expiry', 'Expired on', 'date'), c('days', 'Days ago', 'num'), c('qty', 'Qty'), c('value', 'Loss value (cost)', 'money')],
    rows: async (t) => batchRows(t, 'expired'),
  },
  {
    key: 'dead',
    group: 'Stock',
    name: 'Dead stock (no sale in 90 days)',
    range: 'none',
    cols: [c('product', 'Product'), c('last', 'Last sold', 'date'), c('qty', 'On hand'), c('value', 'Stuck at cost', 'money')],
    rows: async (t) => {
      const cut = new Date(Date.now() - 90 * DAY);
      const p = await ProductModel.find({ shopId: t.shopId, isActive: true, 'stock.onHand': { $gt: 0 }, $or: [{ lastSoldAt: { $lt: cut } }, { lastSoldAt: null }] }).sort({ 'stock.value': -1 }).limit(MAX).select('name units stock.onHand stock.value lastSoldAt').lean();
      return totalRow(p.map((x) => ({ product: x.name, last: x.lastSoldAt ? x.lastSoldAt.toISOString() : null, qty: fromBase(x.stock.onHand, x.units as Units), value: x.stock.value })), { product: 'Total', qty: '' }, ['value']);
    },
  },
  {
    key: 'movements',
    group: 'Stock',
    name: 'Stock movement ledger',
    range: 'range',
    cols: [c('date', 'Date', 'datetime'), c('product', 'Product'), c('batch', 'Batch'), c('type', 'Type'), c('qty', 'Qty (base)', 'num'), c('balance', 'Balance', 'num'), c('ref', 'Ref'), c('by', 'User')],
    rows: async (t, p) => {
      const m = await MovementModel.find({ shopId: t.shopId, at: inRange(p), type: { $ne: 'RACK_MOVE' } }).sort({ at: -1 }).limit(MAX).select('at productId batchId type quantity balanceAfter refNumber userName').lean();
      const units = await productUnits(t, [...new Set(m.map((x) => String(x.productId)))].map((id) => new Types.ObjectId(id)));
      const batches = new Map((await BatchModel.find({ shopId: t.shopId, _id: { $in: m.map((x) => x.batchId) } }).select('batchNumber').lean()).map((b) => [String(b._id), b.batchNumber]));
      return m.map((x) => ({ date: x.at.toISOString(), product: units.get(String(x.productId))?.name ?? '', batch: batches.get(String(x.batchId)) ?? '', type: x.type, qty: x.quantity, balance: x.balanceAfter, ref: x.refNumber ?? '', by: x.userName }));
    },
  },
  {
    key: 'purchase-register',
    group: 'Purchase',
    name: 'Purchase register',
    range: 'range',
    cols: [c('invoice', 'Invoice'), c('date', 'Date', 'date'), c('supplier', 'Supplier'), c('items', 'Items', 'num'), c('taxable', 'Taxable', 'money'), c('tax', 'GST', 'money'), c('total', 'Total', 'money'), c('paid', 'Paid', 'money'), c('due', 'Due', 'money')],
    rows: async (t, p) => {
      const x = await PurchaseModel.find({ shopId: t.shopId, status: 'active', invoiceDate: inRange(p) }).sort({ invoiceDate: -1 }).limit(MAX).select('invoiceNumber invoiceDate supplierName lines taxableAmount cgst sgst grandTotal paidAmount dueAmount').lean();
      return totalRow(x.map((r) => ({ invoice: r.invoiceNumber, date: r.invoiceDate.toISOString(), supplier: r.supplierName, items: r.lines.length, taxable: r.taxableAmount, tax: r.cgst + r.sgst, total: r.grandTotal, paid: r.paidAmount, due: r.dueAmount })), { invoice: 'Total', date: null }, ['items', 'taxable', 'tax', 'total', 'paid', 'due']);
    },
  },
  {
    key: 'supplier-ledger',
    group: 'Purchase',
    name: 'Supplier ledger',
    range: 'none',
    note: 'Balance = purchases − payments − returns, per supplier (all time).',
    cols: [c('supplier', 'Supplier'), c('purchases', 'Purchases', 'money'), c('paid', 'Paid', 'money'), c('returns', 'Returns', 'money'), c('balance', 'Balance', 'money')],
    rows: async (t) => {
      const [s, pur, pay, ret] = await Promise.all([
        SupplierModel.find({ shopId: t.shopId }).sort({ name: 1 }).select('name payableBalance').lean(),
        PurchaseModel.aggregate<{ _id: Types.ObjectId; v: number }>([{ $match: { shopId: t.shopId, status: 'active' } }, { $group: { _id: '$supplierId', v: { $sum: '$grandTotal' } } }]),
        SupplierPaymentModel.aggregate<{ _id: Types.ObjectId; v: number }>([{ $match: { shopId: t.shopId } }, { $group: { _id: '$supplierId', v: { $sum: '$amount' } } }]),
        PurchaseReturnModel.aggregate<{ _id: Types.ObjectId; v: number }>([{ $match: { shopId: t.shopId } }, { $group: { _id: '$supplierId', v: { $sum: '$total' } } }]),
      ]);
      const get = (rows: { _id: Types.ObjectId; v: number }[], id: Types.ObjectId) => rows.find((r) => String(r._id) === String(id))?.v ?? 0;
      return totalRow(s.map((x) => ({ supplier: x.name, purchases: get(pur, x._id), paid: get(pay, x._id), returns: get(ret, x._id), balance: x.payableBalance })), { supplier: 'Total' }, ['purchases', 'paid', 'returns', 'balance']);
    },
  },
  {
    key: 'supplier-outstanding',
    group: 'Purchase',
    name: 'Supplier outstanding',
    range: 'none',
    cols: [c('supplier', 'Supplier'), c('due', 'Total due', 'money'), c('oldest', 'Oldest unpaid bill', 'date'), c('days', 'Days', 'num'), c('overdue', 'Overdue', 'money')],
    rows: async (t) => {
      const today = Date.now();
      const g = await PurchaseModel.aggregate<{ _id: Types.ObjectId; name: string; due: number; oldest: Date; overdue: number }>([
        { $match: { shopId: t.shopId, status: 'active', dueAmount: { $gt: 0 } } },
        { $group: { _id: '$supplierId', name: { $first: '$supplierName' }, due: { $sum: '$dueAmount' }, oldest: { $min: '$invoiceDate' }, overdue: { $sum: { $cond: [{ $lt: ['$dueDate', new Date()] }, '$dueAmount', 0] } } } },
        { $sort: { due: -1 } },
      ]);
      return totalRow(g.map((x) => ({ supplier: x.name, due: x.due, oldest: x.oldest.toISOString(), days: Math.floor((today - x.oldest.getTime()) / DAY), overdue: x.overdue })), { supplier: 'Total', oldest: null, days: null }, ['due', 'overdue']);
    },
  },
  {
    key: 'customer-outstanding',
    group: 'Customers',
    name: 'Customer outstanding (udhaar)',
    range: 'none',
    cols: [c('customer', 'Customer'), c('phone', 'Phone'), c('due', 'Udhaar', 'money'), c('oldest', 'Oldest bill', 'date'), c('days', 'Days', 'num')],
    rows: async (t) => {
      const [cs, old] = await Promise.all([
        CustomerModel.find({ shopId: t.shopId, creditBalance: { $gt: 0 } }).sort({ creditBalance: -1 }).limit(MAX).select('name phone creditBalance').lean(),
        SaleModel.aggregate<{ _id: Types.ObjectId; oldest: Date }>([{ $match: { shopId: t.shopId, dueAmount: { $gt: 0 }, ...live } }, { $group: { _id: '$customerId', oldest: { $min: '$billDate' } } }]),
      ]);
      const o = new Map(old.map((x) => [String(x._id), x.oldest]));
      return totalRow(cs.map((x) => {
        const d = o.get(String(x._id));
        return { customer: x.name, phone: x.phone, due: x.creditBalance, oldest: d ? d.toISOString() : null, days: d ? Math.floor((Date.now() - d.getTime()) / DAY) : null };
      }), { customer: 'Total', phone: '', oldest: null, days: null }, ['due']);
    },
  },
  {
    key: 'top-customers',
    group: 'Customers',
    name: 'Top customers',
    range: 'range',
    cols: [c('customer', 'Customer'), c('bills', 'Bills', 'num'), c('spend', 'Spend', 'money'), c('avg', 'Avg bill', 'money'), c('points', 'Points now', 'num'), c('tier', 'Tier')],
    rows: async (t, p) => {
      const g = await SaleModel.aggregate<{ _id: Types.ObjectId; bills: number; spend: number }>([
        { $match: { shopId: t.shopId, billDate: inRange(p), ...live, customerId: { $ne: null } } },
        { $group: { _id: '$customerId', bills: { $sum: 1 }, spend: { $sum: '$grandTotal' } } },
        { $sort: { spend: -1 } },
        { $limit: 100 },
      ]);
      const cs = new Map((await CustomerModel.find({ shopId: t.shopId, _id: { $in: g.map((x) => x._id) } }).select('name loyaltyPoints tier').lean()).map((x) => [String(x._id), x]));
      return g.map((x) => {
        const cu = cs.get(String(x._id));
        return { customer: cu?.name ?? '', bills: x.bills, spend: x.spend, avg: Math.round(x.spend / x.bills), points: cu?.loyaltyPoints ?? 0, tier: cu?.tier ?? '' };
      });
    },
  },
  {
    key: 'loyalty',
    group: 'Customers',
    name: 'Loyalty points',
    range: 'range',
    note: 'Issued and used in the range; outstanding and its value as of today.',
    cols: [c('issued', 'Issued', 'num'), c('redeemed', 'Used on bills', 'num'), c('expired', 'Expired', 'num'), c('other', 'Manual / returns', 'num'), c('outstanding', 'Outstanding now', 'num'), c('liability', 'Worth now', 'money')],
    rows: async (t, p) => {
      const [g, [o], shop] = await Promise.all([
        LoyaltyModel.aggregate<{ _id: string; points: number }>([{ $match: { shopId: t.shopId, createdAt: inRange(p) } }, { $group: { _id: '$type', points: { $sum: '$points' } } }]),
        CustomerModel.aggregate<{ points: number }>([{ $match: { shopId: t.shopId } }, { $group: { _id: null, points: { $sum: '$loyaltyPoints' } } }]),
        ShopModel.findById(t.shopId).select('settings.loyalty.pointValue').lean(),
      ]);
      const by = (types: string[]) => sum(g.filter((x) => types.includes(x._id)), (x) => x.points);
      const outstanding = o?.points ?? 0;
      return [{ issued: by(['EARN', 'SIGNUP', 'BIRTHDAY']), redeemed: -by(['REDEEM']), expired: -by(['EXPIRE']), other: by(['MANUAL_ADD', 'MANUAL_DEDUCT', 'REVERSAL']), outstanding, liability: outstanding * (shop?.settings.loyalty?.pointValue ?? 100) }];
    },
  },
  {
    key: 'gst-sales',
    group: 'Tax & compliance',
    name: 'GST sales summary (HSN-wise)',
    range: 'range',
    note: 'From each bill line’s own rate and HSN (snapshot), less returns. A guide for your CA — not a filing.',
    cols: [c('hsn', 'HSN'), c('rate', 'Rate %', 'pct'), c('taxable', 'Taxable', 'money'), c('cgst', 'CGST', 'money'), c('sgst', 'SGST', 'money'), c('igst', 'IGST', 'money'), c('total', 'Total', 'money')],
    rows: async (t, p) => {
      const rows = (await gstSales(t, p)).map((x) => ({ hsn: x.hsn || '—', rate: x.rate, taxable: x.taxable, cgst: x.cgst, sgst: x.sgst, igst: x.igst, total: x.taxable + x.cgst + x.sgst + x.igst }));
      return totalRow(rows, { hsn: 'Total', rate: null }, ['taxable', 'cgst', 'sgst', 'igst', 'total']);
    },
  },
  {
    key: 'gst-purchase',
    group: 'Tax & compliance',
    name: 'GST purchase summary (supplier-wise)',
    range: 'range',
    cols: [c('gstin', 'Supplier GSTIN'), c('supplier', 'Supplier'), c('invoices', 'Invoices', 'num'), c('taxable', 'Taxable', 'money'), c('tax', 'GST', 'money'), c('total', 'Total', 'money')],
    rows: async (t, p) => {
      const rows = (await gstPurchases(t, p)).map((x) => ({ gstin: x.gstin || '—', supplier: x.supplier, invoices: x.invoices, taxable: x.taxable, tax: x.cgst + x.sgst, total: x.taxable + x.cgst + x.sgst }));
      return totalRow(rows, { gstin: 'Total', supplier: '' }, ['invoices', 'taxable', 'tax', 'total']);
    },
  },
  {
    key: 'h1',
    group: 'Tax & compliance',
    name: 'Schedule H1 register',
    range: 'range',
    note: 'Kept for drug-inspector visits: date, bill, patient, doctor, drug, batch, quantity.',
    cols: [c('date', 'Date', 'datetime'), c('bill', 'Bill'), c('patient', 'Patient'), c('doctor', 'Doctor'), c('drug', 'Drug'), c('batch', 'Batch'), c('qty', 'Qty (base)', 'num')],
    rows: async (t, p) => scheduleRows(t, p, 'H1'),
  },
  {
    key: 'x',
    group: 'Tax & compliance',
    name: 'Schedule X register',
    range: 'range',
    cols: [c('date', 'Date', 'datetime'), c('bill', 'Bill'), c('patient', 'Patient'), c('doctor', 'Doctor'), c('drug', 'Drug'), c('batch', 'Batch'), c('qty', 'Qty (base)', 'num')],
    rows: async (t, p) => scheduleRows(t, p, 'X'),
  },
  {
    key: 'expenses',
    group: 'Money',
    name: 'Expense report',
    range: 'range',
    cols: [c('date', 'Date', 'date'), c('number', 'Number'), c('category', 'Category'), c('description', 'Description'), c('amount', 'Amount', 'money'), c('mode', 'Mode'), c('drawer', 'From drawer'), c('by', 'By')],
    rows: async (t, p) => {
      const e = await ExpenseModel.find({ shopId: t.shopId, status: 'active', date: inRange(p) }).sort({ date: -1 }).limit(MAX).lean();
      return totalRow(e.map((x) => ({ date: x.date.toISOString(), number: x.expenseNumber, category: x.category, description: x.description, amount: x.amount, mode: x.paymentMode, drawer: x.fromDrawer ? 'Yes' : '', by: x.createdByName })), { date: null, number: 'Total' }, ['amount']);
    },
  },
  {
    key: 'daybook',
    group: 'Money',
    name: 'Day-wise sales, purchases & profit',
    range: 'month',
    note: 'Net = gross profit − expenses − write-offs − points used. The total matches Profit & Loss for the month.',
    cols: [c('day', 'Day', 'date'), c('bills', 'Bills', 'num'), c('sales', 'Sales', 'money'), c('returns', 'Returns', 'money'), c('purchases', 'Purchases', 'money'), c('gross', 'Gross profit', 'money'), c('expenses', 'Expenses', 'money'), c('writeOff', 'Write-offs', 'money'), c('points', 'Points', 'money'), c('net', 'Net profit', 'money')],
    rows: async (t, p) => {
      const d = await daybook(t, p.month);
      return [...d.days.reverse().map((x) => ({ ...x })), { day: 'Total', ...d.total, __total: 1 }];
    },
  },
  {
    key: 'pnl',
    group: 'Money',
    name: 'Profit & Loss',
    range: 'range',
    cols: [c('line', 'Line'), c('amount', 'Amount', 'money')],
    rows: async (t, p) => {
      const x = await pnl(t, p.from, p.to);
      const out: Row[] = [
        { line: 'Revenue (net of returns, ex-GST)', amount: x.revenue },
        { line: '− Cost of goods sold', amount: x.cogs },
        { line: '= Gross profit', amount: x.gross, __total: 1 },
        { line: '− Expenses', amount: x.expenses },
        { line: '− Expiry / damage write-offs', amount: x.writeOff },
        { line: '− Points used by customers', amount: x.points },
        { line: '= Net profit', amount: x.net, __total: 1 },
      ];
      return out;
    },
  },
];

async function batchRows(t: TenantContext, kind: 'soon' | 'expired') {
  const now = new Date();
  const r = expiryRange('expired', now);
  const q = kind === 'expired' ? { $lt: r.to } : { $gte: now, $lte: new Date(now.getTime() + 90 * DAY) };
  const b = await BatchModel.find({ shopId: t.shopId, status: 'active', quantity: { $gt: 0 }, expiryDate: q }).sort({ expiryDate: 1 }).limit(MAX).select('productId batchNumber expiryDate quantity costPerBaseUnit').lean();
  const units = await productUnits(t, [...new Set(b.map((x) => String(x.productId)))].map((id) => new Types.ObjectId(id)));
  const rows = b.map((x) => {
    const p = units.get(String(x.productId));
    return { product: p?.name ?? '', batch: x.batchNumber, expiry: x.expiryDate.toISOString(), days: Math.abs(Math.floor((x.expiryDate.getTime() - now.getTime()) / DAY)), qty: p ? fromBase(x.quantity, p.units as Units) : String(x.quantity), value: x.quantity * x.costPerBaseUnit };
  });
  return totalRow(rows, { product: 'Total', expiry: null, days: null, qty: '' }, ['value']);
}

async function scheduleRows(t: TenantContext, p: Params, schedule: string) {
  const s = await SaleModel.aggregate<{ billNumber: string; billDate: Date; patientName: string; customerName: string; doctorName: string; line: { productName: string; batchNumber: string; quantityInBase: number } }>([
    { $match: { shopId: t.shopId, billDate: inRange(p), ...live, 'lines.schedule': schedule } },
    { $unwind: '$lines' },
    { $match: { 'lines.schedule': schedule } },
    { $sort: { billDate: -1 } },
    { $limit: MAX },
    { $project: { billNumber: 1, billDate: 1, patientName: 1, customerName: 1, doctorName: 1, line: '$lines' } },
  ]);
  return s.map((x) => ({ date: x.billDate.toISOString(), bill: x.billNumber, patient: x.patientName || x.customerName, doctor: x.doctorName, drug: x.line.productName, batch: x.line.batchNumber, qty: x.line.quantityInBase }));
}

/** HSN + rate from each line's snapshot (D62), returns taken out at their own line's rate. */
export async function gstSales(t: TenantContext, p: Params) {
  const key = { hsn: '$lines.hsn', rate: '$lines.gstRate' };
  const [s, r] = await Promise.all([
    SaleModel.aggregate<{ _id: { hsn: string; rate: number }; taxable: number; cgst: number; sgst: number; igst: number }>([{ $match: { shopId: t.shopId, billDate: inRange(p), ...live } }, { $unwind: '$lines' }, { $group: { _id: key, taxable: { $sum: '$lines.taxableAmount' }, cgst: { $sum: '$lines.cgst' }, sgst: { $sum: '$lines.sgst' }, igst: { $sum: '$lines.igst' } } }]),
    SaleReturnModel.aggregate<{ _id: { hsn: string; rate: number }; taxable: number; cgst: number; sgst: number; igst: number }>([{ $match: { shopId: t.shopId, returnDate: inRange(p) } }, { $unwind: '$lines' }, { $group: { _id: key, taxable: { $sum: '$lines.taxable' }, cgst: { $sum: '$lines.cgst' }, sgst: { $sum: '$lines.sgst' }, igst: { $sum: '$lines.igst' } } }]),
  ]);
  const m = new Map<string, { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  const add = (x: (typeof s)[number], sign: number) => {
    const k = `${x._id.hsn}|${String(x._id.rate)}`;
    const v = m.get(k) ?? { hsn: x._id.hsn, rate: x._id.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    v.taxable += sign * x.taxable;
    v.cgst += sign * x.cgst;
    v.sgst += sign * x.sgst;
    v.igst += sign * x.igst;
    m.set(k, v);
  };
  s.forEach((x) => { add(x, 1); });
  r.forEach((x) => { add(x, -1); });
  return [...m.values()].sort((a, b) => a.rate - b.rate || b.taxable - a.taxable);
}

export async function gstPurchases(t: TenantContext, p: Params) {
  const g = await PurchaseModel.aggregate<{ _id: Types.ObjectId; supplier: string; invoices: number; taxable: number; cgst: number; sgst: number }>([
    { $match: { shopId: t.shopId, status: 'active', invoiceDate: inRange(p) } },
    { $group: { _id: '$supplierId', supplier: { $first: '$supplierName' }, invoices: { $sum: 1 }, taxable: { $sum: '$taxableAmount' }, cgst: { $sum: '$cgst' }, sgst: { $sum: '$sgst' } } },
    { $sort: { taxable: -1 } },
  ]);
  const gstin = new Map((await SupplierModel.find({ shopId: t.shopId, _id: { $in: g.map((x) => x._id) } }).select('gstin').lean()).map((x) => [String(x._id), x.gstin]));
  return g.map((x) => ({ gstin: gstin.get(String(x._id)) ?? '', supplier: x.supplier, invoices: x.invoices, taxable: x.taxable, cgst: x.cgst, sgst: x.sgst }));
}

export const reportByKey = (key: string) => REPORTS.find((r) => r.key === key);
export const reportList = () => REPORTS.map(({ key, group, name, range, note }) => ({ key, group, name, range, note: note ?? null }));
