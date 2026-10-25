import type { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istDayStart, istIsoDay } from '../../utils/date';
import { salePack, type Units } from '../../utils/units';
import * as F from '../ask/facts';
import { kpis, supplierDue } from '../dashboard/dashboard.service';
import { ProductModel } from '../products/product.model';
import { can } from '../rbac/permissions';
import { due } from '../refills/refills.service';
import { SaleModel } from '../sales/sale.model';
import { ShopModel } from '../shops/shop.model';

// D103: the morning brief — yesterday against a usual day like it, then today's jobs, most urgent first. Every figure
// is worked out here; the AI only reads it when someone asks.

const DAY = 86_400_000;
const WEEKS = 4;
const PACE_DAYS = 30;
const DEAD_DAYS = 90;
const EXPIRY_DAYS = 30;

/** A part the person's role can't see is left out, not an error. */
async function seen<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof F.NoAccess) return null;
    throw err;
  }
}

/** Low and out medicines, the ones that sell fastest first, with how long what's left lasts at the last 30 days' pace. */
async function reorder(t: TenantContext, now: Date) {
  if (!can(t.permissions, 'stock', 'view') && !can(t.permissions, 'products', 'view')) return null;
  const filter = { shopId: t.shopId, isActive: true, 'stock.status': { $in: ['low', 'out'] as ('low' | 'out')[] } };
  const [rows, count, out] = await Promise.all([
    ProductModel.find(filter).limit(300).select('name stock units').lean(),
    ProductModel.countDocuments(filter),
    ProductModel.countDocuments({ ...filter, 'stock.status': 'out' }),
  ]);
  if (!count) return null;
  const sold = await SaleModel.aggregate<{ _id: Types.ObjectId; base: number }>([
    { $match: { shopId: t.shopId, billDate: { $gte: new Date(now.getTime() - PACE_DAYS * DAY) }, status: { $ne: 'cancelled' } } },
    { $unwind: '$lines' },
    { $match: { 'lines.productId': { $in: rows.map((p) => p._id) } } },
    { $group: { _id: '$lines.productId', base: { $sum: '$lines.quantityInBase' } } },
  ]);
  const pace = new Map(sold.map((s) => [String(s._id), s.base]));
  const items = rows
    .map((p) => {
      const pack = salePack(p.units as Units);
      const base = pace.get(String(p._id)) ?? 0;
      const left = p.stock.sellable;
      return { id: String(p._id), name: p.name, out: p.stock.status === 'out', left: Math.floor(left / pack), sold: Math.round((base / pack) * 10) / 10, sale: (p.units as Units).sale, lastsDays: base ? Math.floor(left / (base / PACE_DAYS)) : null };
    })
    .sort((a, b) => b.sold - a.sold || Number(b.out) - Number(a.out) || a.name.localeCompare(b.name))
    .slice(0, 5);
  return { kind: 'reorder' as const, count, out, paceDays: PACE_DAYS, items };
}

async function expiry(t: TenantContext, now: Date) {
  const [soon, gone] = await Promise.all([F.expiring(t, EXPIRY_DAYS, now), F.expired(t, now)]);
  if (!soon.count && !gone.count) return null;
  return { kind: 'expiry' as const, days: EXPIRY_DAYS, count: soon.count, mrpValue: soon.mrpValue, expired: gone.count, items: soon.items.slice(0, 3).map((b) => ({ id: b.productId, name: b.name, batchNumber: b.batchNumber, expiryDate: b.expiryDate })) };
}

async function suppliers(t: TenantContext, now: Date) {
  if (!can(t.permissions, 'suppliers', 'view')) return null;
  const d = await supplierDue(t, now);
  if (!d.dueWeek && !d.overdue) return null;
  return { kind: 'suppliers' as const, dueWeek: d.dueWeek, overdue: d.overdue, total: d.total };
}

async function udhaar(t: TenantContext) {
  const d = await F.udhaarOf(t, null);
  if (!d.total) return null;
  return { kind: 'udhaar' as const, total: d.total, customers: d.customers, items: d.items.slice(0, 3).map((c) => ({ id: c.id, name: c.name, due: c.due })) };
}

/** Regular customers due back for a medicine (refills screen), not yet reminded. */
async function refill(t: TenantContext, now: Date) {
  if (!can(t.permissions, 'customers', 'view')) return null;
  const d = await due(t, now);
  const open = d.rows.filter((r) => !r.reminded);
  if (!open.length) return null;
  return { kind: 'refill' as const, count: open.length, items: open.slice(0, 3).map((r) => ({ id: r.customerId, name: r.name, product: r.product, late: r.late })) };
}

async function dead(t: TenantContext, now: Date) {
  const d = await F.notSelling(t, DEAD_DAYS, now);
  if (!d.count) return null;
  return { kind: 'dead' as const, days: DEAD_DAYS, count: d.count, mrpValue: d.mrpValue, items: d.items.slice(0, 3).map((p) => ({ id: p.id, name: p.name })) };
}

export async function brief(t: TenantContext, userId: string, now = new Date()) {
  const today = istDayStart(now);
  const day = new Date(today.getTime() - DAY);
  const shop = await ShopModel.findById(t.shopId).select('createdAt').lean();
  const born = shop?.createdAt ?? day;
  // The same weekday in the weeks before, only those the shop already had.
  const past = Array.from({ length: WEEKS }, (_, i) => new Date(day.getTime() - (i + 1) * 7 * DAY)).filter((d) => d.getTime() + DAY > born.getTime());
  const [k, rows, parts] = await Promise.all([
    kpis(t, userId, day, today),
    Promise.all(past.map(async (d) => ({ day: istIsoDay(d), netSales: (await kpis(t, userId, d, new Date(d.getTime() + DAY))).netSales }))),
    Promise.all([seen(() => reorder(t, now)), seen(() => expiry(t, now)), seen(() => suppliers(t, now)), seen(() => udhaar(t)), seen(() => refill(t, now)), seen(() => dead(t, now))]),
  ]);
  const average = rows.length ? Math.round(rows.reduce((n, r) => n + r.netSales, 0) / rows.length) : null;
  const [re, ex, su, ud, rf, de] = parts;
  // Most urgent first: nothing to sell, stock that can't be sold, money owed now, money to collect, money stuck.
  const all = [re, ex, su, ud, rf, de];
  const urgent = new Set<(typeof all)[number]>([re?.out ? re : null, ex?.expired ? ex : null, su?.overdue ? su : null]);
  const todo = [...all.filter((p) => urgent.has(p)), ...all.filter((p) => !urgent.has(p))].filter((p) => p !== null);
  return {
    day: istIsoDay(day),
    ownOnly: t.scopes.sales === 'own',
    yesterday: { netSales: k.netSales, bills: k.bills, avgBill: k.avgBill, grossProfit: k.profit?.gross ?? null, marginPercent: k.profit?.margin ?? null },
    usual: average === null ? null : { average, days: rows },
    changePercent: average ? Math.round(((k.netSales - average) * 1000) / average) / 10 : null,
    todo,
  };
}
export type Brief = Awaited<ReturnType<typeof brief>>;
