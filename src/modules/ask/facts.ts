import { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istDayStart, istIsoDay, istMonth } from '../../utils/date';
import { salePack, type Units } from '../../utils/units';
import { CustomerModel } from '../customers/customer.model';
import { cashDay } from '../dayclose/dayclose.service';
import { expiryBlock, kpis, seesCost, stockBlock, supplierDue, udhaar } from '../dashboard/dashboard.service';
import { ExpenseModel } from '../expenses/expense.model';
import { OrderModel } from '../orders/order.model';
import { summary as orderSummary } from '../orders/orders.service';
import { summary as purchaseSummary } from '../purchases/purchases.service';
import { gstMonth } from '../reports/gst.service';
import { ProductModel } from '../products/product.model';
import { batchesOf, similar } from '../products/products.service';
import { PurchaseModel } from '../purchases/purchase.model';
import { can, type Action, type Module } from '../rbac/permissions';
import { SaleModel } from '../sales/sale.model';
import { BatchModel } from '../stock/batch.model';
import { expiryRange } from '../stock/stock.domain';
import { SupplierModel } from '../suppliers/supplier.model';

// D81: what the chat can tell, in one place — the free layer and the AI's tools both call these, with the asker's
// own permissions and "own bills only" scope, exactly as the screens do.

const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;

export type Period = { key: 'today' | 'yesterday' | 'week' | 'month' | 'last_month' } | { key: 'days'; n: number };

const monthStart = (at: Date, back = 0) => {
  const ist = new Date(at.getTime() + IST);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - back, 1) - IST);
};

/** [from, to) in IST days; a week starts on Monday. */
export function rangeOf(p: Period, now: Date) {
  const d0 = istDayStart(now);
  const end = new Date(d0.getTime() + DAY);
  if (p.key === 'days') return { from: new Date(d0.getTime() - (p.n - 1) * DAY), to: end };
  if (p.key === 'today') return { from: d0, to: end };
  if (p.key === 'yesterday') return { from: new Date(d0.getTime() - DAY), to: d0 };
  if (p.key === 'week') return { from: new Date(d0.getTime() - ((new Date(d0.getTime() + IST).getUTCDay() + 6) % 7) * DAY), to: end };
  if (p.key === 'month') return { from: monthStart(now), to: end };
  return { from: monthStart(now, 1), to: monthStart(now) };
}

export class NoAccess extends Error {}
const need = (t: TenantContext, ...any: [Module, Action?][]) => {
  if (!any.some(([m, a]) => can(t.permissions, m, a ?? 'view'))) throw new NoAccess();
};
const SELLS: [Module, Action?][] = [['sales'], ['pos', 'create']];
const ownOf = (t: TenantContext, userId: string) => (t.scopes.sales === 'own' ? { createdBy: new Types.ObjectId(userId) } : {});
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const latin = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function sales(t: TenantContext, userId: string, period: Period, now: Date) {
  need(t, ...SELLS);
  const { from, to } = rangeOf(period, now);
  return { period, ownOnly: t.scopes.sales === 'own', ...(await kpis(t, userId, from, to)) };
}

export async function profit(t: TenantContext, userId: string, period: Period, now: Date) {
  if (!seesCost(t)) throw new NoAccess();
  return sales(t, userId, period, now);
}

export async function topItems(t: TenantContext, userId: string, period: Period, now: Date) {
  need(t, ...SELLS);
  const { from, to } = rangeOf(period, now);
  const rows = await SaleModel.aggregate<{ _id: Types.ObjectId; name: string; base: number; pack: number; amount: number }>([
    { $match: { shopId: t.shopId, ...ownOf(t, userId), billDate: { $gte: from, $lt: to }, status: { $ne: 'cancelled' } } },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.productId', name: { $first: '$lines.productName' }, base: { $sum: '$lines.quantityInBase' }, pack: { $first: '$lines.salePack' }, amount: { $sum: '$lines.totalAmount' } } },
    { $sort: { amount: -1, _id: 1 } },
    { $limit: 10 },
  ]);
  return { period, ownOnly: t.scopes.sales === 'own', items: rows.map((r) => ({ id: String(r._id), name: r.name, packs: Math.round((r.base / Math.max(1, r.pack)) * 10) / 10, amount: r.amount })) };
}

/** Products whose name, salt or company starts with every word (as the product list searches). */
async function findProducts(t: TenantContext, name: string) {
  const words = latin(name).split(' ').filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const by = (ws: string[]) => ProductModel.find({ shopId: t.shopId, isActive: true, $and: ws.map((w) => ({ searchKey: { $regex: `(^| )${escape(w)}` } })) }).sort({ nameLower: 1 }).limit(5).select('name stock units saltKey gstRate').lean();
  const all = await by(words);
  return all.length || words.length === 1 ? all : by(words.slice(0, 1));
}

const qtyOf = (base: number, u: Units) => {
  const pack = salePack(u);
  const packs = Math.floor(base / pack);
  const loose = base - packs * pack;
  return { packs, loose, sale: u.sale, base: u.base };
};

export async function stockOf(t: TenantContext, name: string) {
  need(t, ['products'], ['stock']);
  const found = await findProducts(t, name);
  const top = found[0];
  if (!top) return { name, found: null, others: [] };
  const batches = (await batchesOf(t, String(top._id))).filter((b) => b.bucket !== 'expired').slice(0, 3);
  const u = top.units as Units;
  return {
    name,
    found: { id: String(top._id), name: top.name, status: top.stock.status, qty: qtyOf(top.stock.sellable, u), nextExpiry: top.stock.nextExpiry ?? null, batches: batches.map((b) => ({ batchNumber: b.batchNumber, expiryDate: b.expiryDate, qty: qtyOf(b.quantity, u), rack: b.rack })) },
    others: found.slice(1).map((p) => ({ id: String(p._id), name: p.name, qty: qtyOf(p.stock.sellable, p.units as Units) })),
  };
}

export async function stockSummary(t: TenantContext) {
  need(t, ['products'], ['stock']);
  const s = await stockBlock(t);
  return { products: s.products, low: s.low, out: s.out, mrpValue: s.mrpValue, value: seesCost(t) ? s.value : null };
}

export async function lowStock(t: TenantContext) {
  need(t, ['products'], ['stock']);
  const filter = { shopId: t.shopId, isActive: true, 'stock.status': { $in: ['low', 'out'] as ('low' | 'out')[] } };
  const [rows, out, low] = await Promise.all([
    ProductModel.find(filter).sort({ 'stock.status': -1, nameLower: 1 }).limit(10).select('name stock units reorderLevel').lean(),
    ProductModel.countDocuments({ ...filter, 'stock.status': 'out' }),
    ProductModel.countDocuments({ ...filter, 'stock.status': 'low' }),
  ]);
  return { out, low, items: rows.map((p) => ({ id: String(p._id), name: p.name, status: p.stock.status, qty: qtyOf(p.stock.sellable, p.units as Units) })) };
}

async function batchList(t: TenantContext, expiryDate: Record<string, Date>) {
  const match = { shopId: t.shopId, status: 'active', quantity: { $gt: 0 }, expiryDate };
  const [rows, [sum]] = await Promise.all([
    BatchModel.aggregate<{ productId: Types.ObjectId; name: string; batchNumber: string; expiryDate: Date; quantity: number; salePack: number; mrp: number; rack: string }>([
      { $match: match },
      { $sort: { expiryDate: 1, _id: 1 } },
      { $limit: 10 },
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p', pipeline: [{ $project: { name: 1 } }] } },
      { $project: { _id: 0, productId: 1, name: { $ifNull: [{ $first: '$p.name' }, ''] }, batchNumber: 1, expiryDate: 1, quantity: 1, salePack: 1, mrp: 1, rack: 1 } },
    ]),
    BatchModel.aggregate<{ count: number; mrp: number }>([{ $match: match }, { $group: { _id: null, count: { $sum: 1 }, mrp: { $sum: { $floor: { $add: [{ $divide: [{ $multiply: ['$mrp', '$quantity'] }, '$salePack'] }, 0.5] } } } } }]),
  ]);
  return { count: sum?.count ?? 0, mrpValue: sum?.mrp ?? 0, items: rows.map((b) => ({ productId: String(b.productId), name: b.name, batchNumber: b.batchNumber, expiryDate: b.expiryDate, packs: Math.round((b.quantity / Math.max(1, b.salePack)) * 10) / 10, rack: b.rack })) };
}

export async function expiring(t: TenantContext, days: number, now: Date) {
  need(t, ['stock']);
  return { days, ...(await batchList(t, { $gte: now, $lte: new Date(now.getTime() + days * DAY) })) };
}

/** The Expiry screen's own "expired" bucket. */
export async function expired(t: TenantContext, now: Date) {
  need(t, ['stock']);
  const to = expiryRange('expired', now).to ?? now;
  return batchList(t, { $lt: to });
}

export async function expirySummary(t: TenantContext, now: Date) {
  need(t, ['stock']);
  return expiryBlock(t, now);
}

export async function udhaarOf(t: TenantContext, name: string | null) {
  need(t, ['customers']);
  if (!name) {
    const [total, rows] = await Promise.all([udhaar(t), CustomerModel.find({ shopId: t.shopId, creditBalance: { $gt: 0 } }).sort({ creditBalance: -1, _id: 1 }).limit(10).select('name creditBalance creditLimit').lean()]);
    return { name: null, ...total, items: rows.map((c) => ({ id: String(c._id), name: c.name, due: c.creditBalance, limit: c.creditLimit })) };
  }
  const rows = await CustomerModel.find({ shopId: t.shopId, nameLower: { $regex: escape(name.toLowerCase()) } }).sort({ creditBalance: -1, _id: 1 }).limit(5).select('name creditBalance creditLimit').lean();
  return { name, total: rows.reduce((a, c) => a + c.creditBalance, 0), customers: rows.length, items: rows.map((c) => ({ id: String(c._id), name: c.name, due: c.creditBalance, limit: c.creditLimit })) };
}

export async function supplierDues(t: TenantContext, name: string | null, now: Date) {
  need(t, ['suppliers']);
  const filter = name ? { shopId: t.shopId, nameLower: { $regex: escape(name.toLowerCase()) } } : { shopId: t.shopId, payableBalance: { $gt: 0 } };
  const [total, rows] = await Promise.all([name ? null : supplierDue(t, now), SupplierModel.find(filter).sort({ payableBalance: -1, _id: 1 }).limit(name ? 5 : 10).select('name payableBalance').lean()]);
  const oldest = await PurchaseModel.aggregate<{ _id: Types.ObjectId; dueDate: Date }>([
    { $match: { shopId: t.shopId, supplierId: { $in: rows.map((s) => s._id) }, status: 'active', dueAmount: { $gt: 0 } } },
    { $sort: { dueDate: 1 } },
    { $group: { _id: '$supplierId', dueDate: { $first: '$dueDate' } } },
  ]);
  const due = new Map(oldest.map((o) => [String(o._id), o.dueDate]));
  return { name, summary: total, items: rows.map((s) => ({ id: String(s._id), name: s.name, due: s.payableBalance, oldestDue: due.get(String(s._id)) ?? null })) };
}

export async function sameSalt(t: TenantContext, name: string) {
  need(t, ['products']);
  const top = (await findProducts(t, name))[0];
  if (!top) return { name, found: null, noSalt: false, items: [] };
  const found = { id: String(top._id), name: top.name };
  if (!top.saltKey) return { name, found, noSalt: true, items: [] };
  const rows = await similar(t, found.id);
  return { name, found, noSalt: false, items: rows.map((p) => ({ id: p.id, name: p.name, company: p.company, salt: [p.salt, p.strength].filter(Boolean).join(' '), packs: Math.floor(p.sellable / Math.max(1, p.units.salePack)), sale: p.units.sale })) };
}

export async function cashToday(t: TenantContext, now: Date) {
  need(t, ['pos', 'create']);
  const c = await cashDay(t, istIsoDay(now));
  return { opening: c.opening, cashIn: c.cashIn, cashOut: c.cashOut, expected: c.expected, bills: c.bills };
}

const live = { status: { $ne: 'cancelled' } };

export async function expensesIn(t: TenantContext, period: Period, now: Date) {
  need(t, ['expenses']);
  const { from, to } = rangeOf(period, now);
  const rows = await ExpenseModel.aggregate<{ _id: string; total: number; n: number }>([{ $match: { shopId: t.shopId, status: 'active', date: { $gte: from, $lt: to } } }, { $group: { _id: '$category', total: { $sum: '$amount' }, n: { $sum: 1 } } }, { $sort: { total: -1, _id: 1 } }]);
  return { period, total: rows.reduce((a, r) => a + r.total, 0), entries: rows.reduce((a, r) => a + r.n, 0), items: rows.slice(0, 8).map((r) => ({ category: r._id, total: r.total, n: r.n })) };
}

export async function purchasesIn(t: TenantContext, period: Period, now: Date) {
  need(t, ['purchases']);
  const { from, to } = rangeOf(period, now);
  return { period, ...(await purchaseSummary(t, from, new Date(to.getTime() - 1))) };
}

export async function priceOf(t: TenantContext, name: string) {
  need(t, ['products'], ['pos', 'create']);
  const top = (await findProducts(t, name))[0];
  if (!top) return { name, found: null };
  const batches = (await batchesOf(t, String(top._id))).filter((b) => b.bucket !== 'expired').slice(0, 3);
  const u = top.units as Units;
  return { name, found: { id: String(top._id), name: top.name, sale: u.sale, gstRate: top.gstRate, batches: batches.map((b) => ({ batchNumber: b.batchNumber, mrp: b.mrp, expiryDate: b.expiryDate })) } };
}

/** In stock, and not sold for this many days (or never). */
export async function notSelling(t: TenantContext, days: number, now: Date) {
  need(t, ['products'], ['stock']);
  const filter = { shopId: t.shopId, isActive: true, 'stock.onHand': { $gt: 0 }, $or: [{ lastSoldAt: { $lt: new Date(now.getTime() - days * DAY) } }, { lastSoldAt: null }] };
  const [rows, [sum]] = await Promise.all([
    ProductModel.find(filter).sort({ 'stock.mrpValue': -1, _id: 1 }).limit(10).select('name stock units lastSoldAt').lean(),
    ProductModel.aggregate<{ n: number; mrp: number; value: number }>([{ $match: filter }, { $group: { _id: null, n: { $sum: 1 }, mrp: { $sum: '$stock.mrpValue' }, value: { $sum: '$stock.value' } } }]),
  ]);
  return { days, count: sum?.n ?? 0, mrpValue: sum?.mrp ?? 0, value: seesCost(t) ? (sum?.value ?? 0) : null, items: rows.map((p) => ({ id: String(p._id), name: p.name, qty: qtyOf(p.stock.onHand, p.units as Units), lastSold: p.lastSoldAt ?? null })) };
}

export async function topCustomers(t: TenantContext, userId: string, period: Period, now: Date) {
  need(t, ['customers']);
  need(t, ...SELLS);
  const { from, to } = rangeOf(period, now);
  const rows = await SaleModel.aggregate<{ _id: Types.ObjectId; name: string; bills: number; amount: number }>([
    { $match: { shopId: t.shopId, ...ownOf(t, userId), billDate: { $gte: from, $lt: to }, ...live, customerId: { $ne: null } } },
    { $group: { _id: '$customerId', name: { $last: '$customerName' }, bills: { $sum: 1 }, amount: { $sum: '$grandTotal' } } },
    { $sort: { amount: -1, _id: 1 } },
    { $limit: 10 },
  ]);
  return { period, ownOnly: t.scopes.sales === 'own', items: rows.map((r) => ({ id: String(r._id), name: r.name, bills: r.bills, amount: r.amount })) };
}

/** How the money came in: cash, UPI, card, udhaar (points and advances too). */
export async function payModes(t: TenantContext, userId: string, period: Period, now: Date) {
  need(t, ...SELLS);
  const { from, to } = rangeOf(period, now);
  const rows = await SaleModel.aggregate<{ _id: string; amount: number; bills: number }>([
    { $match: { shopId: t.shopId, ...ownOf(t, userId), billDate: { $gte: from, $lt: to }, ...live } },
    { $unwind: '$payments' },
    { $group: { _id: '$payments.mode', amount: { $sum: '$payments.amount' }, bills: { $sum: 1 } } },
    { $sort: { amount: -1, _id: 1 } },
  ]);
  return { period, ownOnly: t.scopes.sales === 'own', total: rows.reduce((a, r) => a + r.amount, 0), items: rows.map((r) => ({ mode: r._id, amount: r.amount, bills: r.bills })) };
}

export async function openOrders(t: TenantContext) {
  need(t, ['pos', 'create']);
  if (!t.features.includes('orders')) throw new NoAccess();
  const [s, rows] = await Promise.all([orderSummary(t), OrderModel.find({ shopId: t.shopId, status: 'open' }).sort({ createdAt: 1, _id: 1 }).limit(10).select('orderNumber customerName createdAt advance').lean()]);
  return { ...s, items: rows.map((o) => ({ id: String(o._id), number: o.orderNumber, customer: o.customerName, at: o.createdAt, advance: o.advance })) };
}

export async function gstOf(t: TenantContext, last: boolean, now: Date) {
  need(t, ['reports']);
  const month = istMonth(last ? new Date(rangeOf({ key: 'last_month' }, now).from.getTime() + DAY) : now);
  const g = await gstMonth(t, month, now);
  return { month, salesTaxable: g.salesTaxable, outTax: g.outTax, inTax: g.inTax, net: g.net };
}

/** Who sold how much — the owner's view, so reports:view. */
export async function staffSales(t: TenantContext, period: Period, now: Date) {
  need(t, ['reports']);
  const { from, to } = rangeOf(period, now);
  const rows = await SaleModel.aggregate<{ _id: Types.ObjectId; name: string; bills: number; amount: number }>([
    { $match: { shopId: t.shopId, billDate: { $gte: from, $lt: to }, ...live } },
    { $group: { _id: '$createdBy', name: { $last: '$createdByName' }, bills: { $sum: 1 }, amount: { $sum: '$grandTotal' } } },
    { $sort: { amount: -1, _id: 1 } },
    { $limit: 10 },
  ]);
  return { period, items: rows.map((r) => ({ name: r.name, bills: r.bills, amount: r.amount })) };
}
