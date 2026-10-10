import { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istDayStart, istIsoDay } from '../../utils/date';
import { salePack, type Units } from '../../utils/units';
import { CustomerModel } from '../customers/customer.model';
import { cashDay } from '../dayclose/dayclose.service';
import { expiryBlock, kpis, seesCost, stockBlock, supplierDue, udhaar } from '../dashboard/dashboard.service';
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
  const by = (ws: string[]) => ProductModel.find({ shopId: t.shopId, isActive: true, $and: ws.map((w) => ({ searchKey: { $regex: `(^| )${escape(w)}` } })) }).sort({ nameLower: 1 }).limit(5).select('name stock units saltKey').lean();
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
