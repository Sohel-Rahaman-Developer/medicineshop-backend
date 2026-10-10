import { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istDayStart, istIsoDay } from '../../utils/date';
import { salePack, type Units } from '../../utils/units';
import { can } from '../rbac/permissions';
import { CustomerModel } from '../customers/customer.model';
import { ExpenseModel } from '../expenses/expense.model';
import { liveAlerts } from '../notifications/alerts.service';
import { ProductModel } from '../products/product.model';
import { PurchaseModel } from '../purchases/purchase.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import { BatchModel } from '../stock/batch.model';
import { NO_EXPIRY, expiryRange } from '../stock/stock.domain';
import { SupplierModel } from '../suppliers/supplier.model';

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;
const TZ = 'Asia/Kolkata';

export type HomeKind = 'owner' | 'counter' | 'stock' | 'money';

/** One Home per role (SANDBOX §5.3); a custom role gets the counter Home unless it can see profit. */
export function kindOf(t: TenantContext): HomeKind {
  if (t.roleKey === 'stockKeeper') return 'stock';
  if (t.roleKey === 'accountant') return 'money';
  return can(t.permissions, 'reports', 'view') ? 'owner' : 'counter';
}

export const seesCost = (t: TenantContext) => can(t.permissions, 'reports', 'view');
/** Cashier `sales: own` sees only own bills here too (D20). */
const scopeOf = (t: TenantContext, userId: string) => (t.scopes.sales === 'own' ? { createdBy: new Types.ObjectId(userId) } : {});

/** Bills and returns in [from, to): net sales = bills − returns; profit only for reports:view (PLAN §7). */
export async function kpis(t: TenantContext, userId: string, from: Date, to: Date) {
  const own = scopeOf(t, userId);
  const [[s], [r], cancelled] = await Promise.all([
    SaleModel.aggregate<{ bills: number; gross: number; taxable: number; cost: number; items: number; points: number }>([
      { $match: { shopId: t.shopId, ...own, billDate: { $gte: from, $lt: to }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, bills: { $sum: 1 }, gross: { $sum: '$grandTotal' }, taxable: { $sum: '$taxableAmount' }, cost: { $sum: '$totalCost' }, items: { $sum: { $size: '$lines' } }, points: { $sum: { $ifNull: ['$loyaltyDiscountAmount', 0] } } } },
    ]),
    SaleReturnModel.aggregate<{ n: number; total: number; taxable: number; cost: number }>([
      { $match: { shopId: t.shopId, ...(own.createdBy ? { saleCreatedBy: own.createdBy } : {}), returnDate: { $gte: from, $lt: to } } },
      { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$total' }, taxable: { $sum: '$taxableAmount' }, cost: { $sum: '$totalCost' } } },
    ]),
    SaleModel.countDocuments({ shopId: t.shopId, ...own, billDate: { $gte: from, $lt: to }, status: 'cancelled' }),
  ]);
  const bills = s?.bills ?? 0;
  const gross = s?.gross ?? 0;
  const returns = r?.total ?? 0;
  const out = { bills, gross, returns, returnCount: r?.n ?? 0, netSales: gross - returns, avgBill: bills ? Math.round(gross / bills) : 0, items: s?.items ?? 0, cancelled, points: s?.points ?? 0 };
  if (!seesCost(t)) return { ...out, profit: null };
  const revenue = (s?.taxable ?? 0) - (r?.taxable ?? 0);
  const cogs = (s?.cost ?? 0) - (r?.cost ?? 0);
  return { ...out, profit: { revenue, cogs, gross: revenue - cogs, margin: revenue ? Math.round(((revenue - cogs) * 10_000) / revenue) / 100 : 0 } };
}

export async function stockBlock(t: TenantContext) {
  const [[p], top] = await Promise.all([
    ProductModel.aggregate<{ value: number; mrpValue: number; low: number; out: number; products: number }>([
      { $match: { shopId: t.shopId, isActive: true } },
      { $group: { _id: null, value: { $sum: '$stock.value' }, mrpValue: { $sum: '$stock.mrpValue' }, low: { $sum: { $cond: [{ $eq: ['$stock.status', 'low'] }, 1, 0] } }, out: { $sum: { $cond: [{ $eq: ['$stock.status', 'out'] }, 1, 0] } }, products: { $sum: 1 } } },
    ]),
    BatchModel.aggregate<{ productName: string; batchNumber: string; quantity: number; costPerBaseUnit: number; value: number }>([
      { $match: { shopId: t.shopId, quantity: { $gt: 0 }, status: { $ne: 'returned' } } },
      { $project: { productId: 1, batchNumber: 1, quantity: 1, costPerBaseUnit: 1, value: { $multiply: ['$quantity', '$costPerBaseUnit'] } } },
      { $sort: { value: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p', pipeline: [{ $project: { name: 1 } }] } },
      { $project: { _id: 0, productName: { $ifNull: [{ $first: '$p.name' }, ''] }, batchNumber: 1, quantity: 1, costPerBaseUnit: 1, value: 1 } },
    ]),
  ]);
  return { value: p?.value ?? 0, mrpValue: p?.mrpValue ?? 0, low: p?.low ?? 0, out: p?.out ?? 0, products: p?.products ?? 0, top };
}

/** The expiry centre's own buckets (stock.domain expiryRange), so Home and Expiry show the same numbers. */
export async function expiryBlock(t: TenantContext, now: Date) {
  const one = async (k: 'expired' | 'd30' | 'd60' | 'd90') => {
    const r = expiryRange(k, now);
    const expiryDate = { ...(r.from ? { [k === 'd30' ? '$gte' : '$gt']: r.from } : {}), ...(r.to ? { [k === 'expired' ? '$lt' : '$lte']: r.to } : {}) };
    const [x] = await BatchModel.aggregate<{ count: number; cost: number; mrp: number }>([
      { $match: { shopId: t.shopId, status: 'active', quantity: { $gt: 0 }, expiryDate } },
      { $group: { _id: null, count: { $sum: 1 }, cost: { $sum: { $multiply: ['$quantity', '$costPerBaseUnit'] } }, mrp: { $sum: { $floor: { $add: [{ $divide: [{ $multiply: ['$mrp', '$quantity'] }, '$salePack'] }, 0.5] } } } } },
    ]);
    return { count: x?.count ?? 0, cost: x?.cost ?? 0, mrp: x?.mrp ?? 0 };
  };
  const [expired, d30, d60, d90] = await Promise.all([one('expired'), one('d30'), one('d60'), one('d90')]);
  return { expired, d30, d60, d90 };
}

export async function supplierDue(t: TenantContext, now: Date) {
  const d0 = istDayStart(now);
  const [[s], [p]] = await Promise.all([
    SupplierModel.aggregate<{ total: number; suppliers: number }>([{ $match: { shopId: t.shopId, payableBalance: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$payableBalance' }, suppliers: { $sum: 1 } } }]),
    PurchaseModel.aggregate<{ overdue: number; week: number }>([
      { $match: { shopId: t.shopId, status: 'active', dueAmount: { $gt: 0 } } },
      { $group: { _id: null, overdue: { $sum: { $cond: [{ $lt: ['$dueDate', d0] }, '$dueAmount', 0] } }, week: { $sum: { $cond: [{ $lt: ['$dueDate', new Date(d0.getTime() + 8 * DAY)] }, '$dueAmount', 0] } } } },
    ]),
  ]);
  return { total: s?.total ?? 0, suppliers: s?.suppliers ?? 0, overdue: p?.overdue ?? 0, dueWeek: p?.week ?? 0 };
}

export async function udhaar(t: TenantContext) {
  const [c] = await CustomerModel.aggregate<{ total: number; customers: number }>([{ $match: { shopId: t.shopId, creditBalance: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$creditBalance' }, customers: { $sum: 1 } } }]);
  return { total: c?.total ?? 0, customers: c?.customers ?? 0 };
}

const monthStart = (now: Date) => {
  const ist = new Date(now.getTime() + IST);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST);
};

/** Month to date: output tax on bills less returns, input tax on purchases. A guide — filing figures come from the CA. */
async function gstMonth(t: TenantContext, now: Date) {
  const m0 = monthStart(now);
  const [[s], [r], [p]] = await Promise.all([
    SaleModel.aggregate<{ tax: number }>([{ $match: { shopId: t.shopId, billDate: { $gte: m0 }, status: { $ne: 'cancelled' } } }, { $group: { _id: null, tax: { $sum: '$totalTax' } } }]),
    SaleReturnModel.aggregate<{ tax: number }>([{ $match: { shopId: t.shopId, returnDate: { $gte: m0 } } }, { $group: { _id: null, tax: { $sum: '$totalTax' } } }]),
    PurchaseModel.aggregate<{ tax: number }>([{ $match: { shopId: t.shopId, status: 'active', invoiceDate: { $gte: m0 } } }, { $group: { _id: null, tax: { $sum: { $add: ['$cgst', '$sgst'] } } } }]),
  ]);
  const outTax = (s?.tax ?? 0) - (r?.tax ?? 0);
  const inTax = p?.tax ?? 0;
  return { from: istIsoDay(m0), outTax, inTax, net: outTax - inTax };
}

async function expensesMonth(t: TenantContext, now: Date) {
  const [e] = await ExpenseModel.aggregate<{ total: number; n: number }>([{ $match: { shopId: t.shopId, status: 'active', date: { $gte: monthStart(now) } } }, { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } }]);
  return { total: e?.total ?? 0, entries: e?.n ?? 0 };
}

async function recent(t: TenantContext, userId: string, n: number) {
  const rows = await SaleModel.find({ shopId: t.shopId, ...scopeOf(t, userId) }).sort({ billDate: -1, _id: -1 }).limit(n).select('billNumber billDate customerName lines grandTotal paymentMode status').lean();
  return rows.map((s) => ({ id: String(s._id), billNumber: s.billNumber, billDate: s.billDate, customerName: s.customerName, items: s.lines.length, grandTotal: s.grandTotal, paymentMode: s.paymentMode, status: s.status }));
}

async function reorderNow(t: TenantContext) {
  const rows = await ProductModel.find({ shopId: t.shopId, isActive: true, 'stock.status': { $in: ['low', 'out'] } }).sort({ 'stock.status': 1, name: 1 }).limit(6).select('name stock units reorderLevel').lean();
  return rows.map((p) => ({ id: String(p._id), name: p.name, sellable: p.stock.sellable, status: p.stock.status, reorderLevel: p.reorderLevel, sale: (p.units as Units).sale, salePack: salePack(p.units as Units) }));
}

/** GET /dashboard: what this person's Home shows, already cut to their permissions. */
export async function overview(t: TenantContext, userId: string, from: Date, to: Date, now = new Date()) {
  const kind = kindOf(t);
  const end = new Date(to.getTime() + DAY);
  const span = end.getTime() - from.getTime();
  const has = (m: Parameters<typeof can>[1], a: Parameters<typeof can>[2] = 'view') => can(t.permissions, m, a);
  const today0 = istDayStart(now);
  const [range, prev, today, stock, expiry, due, credit, gst, expenses, bills, alerts, reorder, purchasesToday] = await Promise.all([
    has('sales') || has('pos', 'create') ? kpis(t, userId, from, end) : null,
    has('sales') || has('pos', 'create') ? kpis(t, userId, new Date(from.getTime() - span), from) : null,
    has('sales') || has('pos', 'create') ? kpis(t, userId, today0, new Date(today0.getTime() + DAY)) : null,
    has('stock') ? stockBlock(t) : null,
    has('stock') ? expiryBlock(t, now) : null,
    has('suppliers') ? supplierDue(t, now) : null,
    has('customers') ? udhaar(t) : null,
    kind === 'money' && seesCost(t) ? gstMonth(t, now) : null,
    has('expenses') ? expensesMonth(t, now) : null,
    has('sales') || has('pos', 'create') ? recent(t, userId, 8) : null,
    liveAlerts(t, now),
    kind === 'stock' ? reorderNow(t) : null,
    kind === 'stock' && has('purchases') ? PurchaseModel.aggregate<{ n: number; total: number }>([{ $match: { shopId: t.shopId, status: 'active', createdAt: { $gte: today0 } } }, { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$grandTotal' } } }]) : null,
  ]);
  return {
    kind,
    ownOnly: t.scopes.sales === 'own',
    range,
    prev,
    today,
    stock: stock && seesCost(t) ? stock : stock ? { ...stock, value: null, top: [] } : null,
    expiry: expiry && !seesCost(t) ? { ...expiry, expired: { ...expiry.expired, cost: null }, d30: { ...expiry.d30, cost: null }, d60: { ...expiry.d60, cost: null }, d90: { ...expiry.d90, cost: null } } : expiry,
    supplierDue: due,
    udhaar: credit,
    gst,
    expenses,
    recent: bills,
    alerts: alerts.slice(0, 6).map((a) => ({ key: a.key, type: a.type, priority: a.priority, title: a.title, route: a.route })),
    reorder,
    purchasesToday: purchasesToday ? { count: purchasesToday[0]?.n ?? 0, total: purchasesToday[0]?.total ?? 0 } : null,
    asOf: now,
  };
}

const hourOf = { $hour: { date: '$billDate', timezone: TZ } };

/** GET /dashboard/charts — each chart follows the range; cost-based ones only for reports:view. */
export async function charts(t: TenantContext, userId: string, from: Date, to: Date, now = new Date()) {
  const end = new Date(to.getTime() + DAY);
  const match = { shopId: t.shopId, ...scopeOf(t, userId), billDate: { $gte: from, $lt: end }, status: { $ne: 'cancelled' } };
  const cost = seesCost(t);
  const [daily, returnsDaily, category, payment, hourly, top, aging] = await Promise.all([
    SaleModel.aggregate<{ _id: string; sales: number; bills: number; profit: number }>([{ $match: match }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$billDate', timezone: TZ } }, sales: { $sum: '$grandTotal' }, bills: { $sum: 1 }, profit: { $sum: { $subtract: ['$taxableAmount', '$totalCost'] } } } }]),
    SaleReturnModel.aggregate<{ _id: string; total: number; profit: number }>([
      { $match: { shopId: t.shopId, ...(t.scopes.sales === 'own' ? { saleCreatedBy: new Types.ObjectId(userId) } : {}), returnDate: { $gte: from, $lt: end } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$returnDate', timezone: TZ } }, total: { $sum: '$total' }, profit: { $sum: { $subtract: ['$taxableAmount', '$totalCost'] } } } },
    ]),
    SaleModel.aggregate<{ _id: string; value: number }>([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: { $cond: [{ $eq: ['$lines.category', ''] }, 'Other', '$lines.category'] }, value: { $sum: '$lines.totalAmount' } } }, { $sort: { value: -1 } }]),
    SaleModel.aggregate<{ _id: string; value: number }>([{ $match: match }, { $unwind: '$payments' }, { $group: { _id: '$payments.mode', value: { $sum: '$payments.amount' } } }, { $sort: { value: -1 } }]),
    SaleModel.aggregate<{ _id: number; bills: number }>([{ $match: match }, { $group: { _id: hourOf, bills: { $sum: 1 } } }]),
    SaleModel.aggregate<{ _id: Types.ObjectId; name: string; value: number; qty: number }>([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $first: '$lines.productName' }, value: { $sum: '$lines.totalAmount' }, qty: { $sum: '$lines.quantityInBase' } } }, { $sort: { value: -1 } }, { $limit: 10 }]),
    expiryAging(t, now, cost),
  ]);
  const days: { day: string; sales: number; bills: number; profit: number | null }[] = [];
  for (let d = from; d < end; d = new Date(d.getTime() + DAY)) {
    const k = istIsoDay(d);
    const s = daily.find((x) => x._id === k);
    const r = returnsDaily.find((x) => x._id === k);
    days.push({ day: k, sales: (s?.sales ?? 0) - (r?.total ?? 0), bills: s?.bills ?? 0, profit: cost ? (s?.profit ?? 0) - (r?.profit ?? 0) : null });
  }
  // 8 am–10 pm, widened to any hour that had a bill (a 24-hour pharmacy bills at night too).
  const seen = hourly.map((x) => x._id);
  const hours = [];
  for (let h = Math.min(8, ...seen); h <= Math.max(22, ...seen); h++) hours.push({ hour: h, bills: hourly.find((x) => x._id === h)?.bills ?? 0 });
  return {
    trend: days,
    category: category.map((c) => ({ key: c._id, value: c.value })),
    payment: payment.map((p) => ({ key: p._id, value: p.value })),
    hourly: hours,
    top: top.map((p) => ({ id: String(p._id), name: p.name, value: p.value, qty: p.qty })),
    aging,
  };
}

/** Next 6 months of expiries by category — at cost for reports:view, else at MRP. */
async function expiryAging(t: TenantContext, now: Date, atCost: boolean) {
  const ist = new Date(now.getTime() + IST);
  const months = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + i, 1) - IST));
  const endAt = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 6, 1) - IST);
  const rows = await BatchModel.aggregate<{ _id: { m: string; c: string }; value: number }>([
    { $match: { shopId: t.shopId, quantity: { $gt: 0 }, status: { $ne: 'returned' }, expiryDate: { $lt: endAt, $ne: NO_EXPIRY } } },
    { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p', pipeline: [{ $project: { categoryId: 1 } }] } },
    { $lookup: { from: 'categories', localField: 'p.categoryId', foreignField: '_id', as: 'c', pipeline: [{ $project: { name: 1 } }] } },
    {
      $group: {
        // Already expired counts in this month's column.
        _id: { m: { $dateToString: { format: '%Y-%m', date: { $max: ['$expiryDate', months[0]] }, timezone: TZ } }, c: { $ifNull: [{ $first: '$c.name' }, 'Other'] } },
        value: { $sum: atCost ? { $multiply: ['$quantity', '$costPerBaseUnit'] } : { $floor: { $add: [{ $divide: [{ $multiply: ['$mrp', '$quantity'] }, '$salePack'] }, 0.5] } } },
      },
    },
  ]);
  const labels = months.map((m) => istIsoDay(m).slice(0, 7));
  const cats = [...new Set(rows.map((r) => r._id.c))];
  return { months: labels, atCost, series: cats.map((c) => ({ name: c, data: labels.map((m) => rows.filter((r) => r._id.c === c && r._id.m === m).reduce((s, r) => s + r.value, 0)) })) };
}
