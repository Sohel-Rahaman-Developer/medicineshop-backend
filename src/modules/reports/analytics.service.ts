// S60 analytics (sandbox insights.js + analytics.js): four tabs of charts, every number from ledgers and bill snapshots.
import { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istDayStart, istIsoDay } from '../../utils/date';
import { salePack, type Units } from '../../utils/units';
import { CustomerModel } from '../customers/customer.model';
import { charts } from '../dashboard/dashboard.service';
import { LoyaltyModel } from '../loyalty/loyalty.model';
import { ProductModel } from '../products/product.model';
import { PurchaseModel, PurchaseReturnModel } from '../purchases/purchase.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import { BatchModel } from '../stock/batch.model';
import { MovementModel } from '../stock/movement.model';

const DAY = 24 * 60 * 60 * 1000;
const TZ = 'Asia/Kolkata';
const live = { status: { $ne: 'cancelled' as const } };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday first, the way a shop week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export type Tab = 'sales' | 'stock' | 'customers' | 'suppliers';

async function salesTab(t: TenantContext, userId: string, from: Date, to: Date) {
  const end = new Date(to.getTime() + DAY);
  const match = { shopId: t.shopId, billDate: { $gte: from, $lt: end }, ...live };
  const [base, byDow, heat, topProfit, staff] = await Promise.all([
    charts(t, userId, from, to),
    SaleModel.aggregate<{ _id: number; value: number; days: string[] }>([{ $match: match }, { $group: { _id: { $dayOfWeek: { date: '$billDate', timezone: TZ } }, value: { $sum: '$grandTotal' }, days: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$billDate', timezone: TZ } } } } }]),
    SaleModel.aggregate<{ _id: { d: number; h: number }; n: number }>([{ $match: match }, { $group: { _id: { d: { $dayOfWeek: { date: '$billDate', timezone: TZ } }, h: { $hour: { date: '$billDate', timezone: TZ } } }, n: { $sum: 1 } } }]),
    SaleModel.aggregate<{ _id: Types.ObjectId; name: string; profit: number }>([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $first: '$lines.productName' }, profit: { $sum: { $subtract: ['$lines.taxableAmount', '$lines.lineCost'] } } } }, { $sort: { profit: -1 } }, { $limit: 10 }]),
    SaleModel.aggregate<{ _id: Types.ObjectId; name: string; value: number; bills: number }>([{ $match: match }, { $group: { _id: '$createdBy', name: { $first: '$createdByName' }, value: { $sum: '$grandTotal' }, bills: { $sum: 1 } } }, { $sort: { value: -1 } }]),
  ]);
  // Mongo's $dayOfWeek is 1 = Sunday.
  const weekday = WEEK.map((d) => {
    const x = byDow.find((r) => r._id === d + 1);
    return { day: DOW[d] ?? '', avg: x?.days.length ? Math.round(x.value / x.days.length) : 0 };
  });
  // 8 am–10 pm, widened to any hour that had a bill (as the dashboard does).
  const seen = heat.map((r) => r._id.h);
  const lo = Math.min(8, ...seen);
  const hours = Array.from({ length: Math.max(22, ...seen) - lo + 1 }, (_, i) => i + lo);
  const heatmap = WEEK.map((d) => ({ name: DOW[d] ?? '', data: hours.map((h) => ({ x: `${String(h % 12 || 12)}${h < 12 ? 'a' : 'p'}`, y: heat.find((r) => r._id.d === d + 1 && r._id.h === h)?.n ?? 0 })) })).reverse();
  return { ...base, weekday, heatmap, topProfit: topProfit.map((p) => ({ name: p.name, value: p.profit })), staff: staff.map((s) => ({ name: s.name, value: s.value, bills: s.bills })) };
}

/** Stock at cost at the end of each day: today's value, walked back through every later movement at its own cost. */
async function valuationTrend(t: TenantContext, days: number, now: Date) {
  const today0 = istDayStart(now);
  const start = new Date(today0.getTime() - (days - 1) * DAY);
  const [[cur], moves] = await Promise.all([
    BatchModel.aggregate<{ v: number }>([{ $match: { shopId: t.shopId, quantity: { $gt: 0 }, status: { $ne: 'returned' } } }, { $group: { _id: null, v: { $sum: { $multiply: ['$quantity', '$costPerBaseUnit'] } } } }]),
    MovementModel.aggregate<{ _id: string; v: number }>([{ $match: { shopId: t.shopId, at: { $gte: new Date(start.getTime() + DAY) } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: TZ } }, v: { $sum: { $multiply: ['$quantity', '$costPerBaseUnit'] } } } }]),
  ]);
  let value = cur?.v ?? 0;
  const out: { day: string; value: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today0.getTime() - i * DAY);
    out.unshift({ day: istIsoDay(d), value });
    // Step back over this day's movements to get the close of the day before.
    value -= moves.find((m) => m._id === istIsoDay(d))?.v ?? 0;
  }
  return out;
}

async function stockTab(t: TenantContext, userId: string, from: Date, to: Date, now: Date) {
  const days = Math.min(90, Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY) + 1));
  const cut30 = new Date(istDayStart(now).getTime() - 29 * DAY);
  const [trend, base, dead, movers, weeks] = await Promise.all([
    valuationTrend(t, days, now),
    charts(t, userId, from, to, now),
    ProductModel.find({ shopId: t.shopId, isActive: true, 'stock.onHand': { $gt: 0 }, $or: [{ lastSoldAt: { $lt: new Date(now.getTime() - 90 * DAY) } }, { lastSoldAt: null }] }).sort({ 'stock.value': -1 }).limit(10).select('name stock.value lastSoldAt').lean(),
    SaleModel.aggregate<{ _id: Types.ObjectId; name: string; qty: number; revenue: number; cost: number }>([{ $match: { shopId: t.shopId, billDate: { $gte: cut30 }, ...live } }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $first: '$lines.productName' }, qty: { $sum: '$lines.quantityInBase' }, revenue: { $sum: '$lines.taxableAmount' }, cost: { $sum: '$lines.lineCost' } } }, { $sort: { qty: -1 } }, { $limit: 40 }]),
    purchaseVsSale(t, now),
  ]);
  const units = new Map((await ProductModel.find({ shopId: t.shopId, _id: { $in: movers.map((m) => m._id) } }).select('units').lean()).map((p) => [String(p._id), salePack(p.units as Units)]));
  return {
    valuation: trend,
    aging: base.aging,
    dead: dead.map((p) => ({ id: String(p._id), name: p.name, value: p.stock.value, lastSold: p.lastSoldAt ?? null })),
    movers: movers.map((m) => ({ name: m.name, perDay: Math.round((m.qty / (units.get(String(m._id)) ?? 1) / 30) * 10) / 10, margin: m.revenue ? Math.round(((m.revenue - m.cost) * 1000) / m.revenue) / 10 : 0 })),
    purchaseVsSale: weeks,
  };
}

/** The last 12 weeks: stock bought (ex-GST) against the cost of what sold — are we over-buying? */
async function purchaseVsSale(t: TenantContext, now: Date) {
  const today0 = istDayStart(now);
  const weeks = Array.from({ length: 12 }, (_, i) => new Date(today0.getTime() - (11 - i) * 7 * DAY - 6 * DAY));
  const start = weeks[0] ?? today0;
  const [p, s, r] = await Promise.all([
    PurchaseModel.find({ shopId: t.shopId, status: 'active', invoiceDate: { $gte: start } }).select('invoiceDate taxableAmount').lean(),
    SaleModel.find({ shopId: t.shopId, billDate: { $gte: start }, ...live }).select('billDate totalCost').lean(),
    SaleReturnModel.find({ shopId: t.shopId, returnDate: { $gte: start } }).select('returnDate totalCost').lean(),
  ]);
  const at = (d: Date) => Math.min(11, Math.floor((d.getTime() - start.getTime()) / (7 * DAY)));
  const out = weeks.map((w) => ({ week: istIsoDay(w), purchases: 0, cogs: 0 }));
  for (const x of p) { const o = out[at(x.invoiceDate)]; if (o) o.purchases += x.taxableAmount; }
  for (const x of s) { const o = out[at(x.billDate)]; if (o) o.cogs += x.totalCost; }
  for (const x of r) { const o = out[at(x.returnDate)]; if (o) o.cogs -= x.totalCost; }
  return out;
}

async function customersTab(t: TenantContext, from: Date, to: Date, now: Date) {
  const end = new Date(to.getTime() + DAY);
  const [firsts, inRange, tiers, top, credit, points, ledger] = await Promise.all([
    SaleModel.aggregate<{ _id: Types.ObjectId; first: Date }>([{ $match: { shopId: t.shopId, customerId: { $ne: null }, ...live } }, { $group: { _id: '$customerId', first: { $min: '$billDate' } } }]),
    SaleModel.aggregate<{ _id: { c: Types.ObjectId; w: number } }>([{ $match: { shopId: t.shopId, customerId: { $ne: null }, billDate: { $gte: from, $lt: end }, ...live } }, { $group: { _id: { c: '$customerId', w: { $floor: { $divide: [{ $subtract: ['$billDate', from] }, 7 * DAY] } } } } }]),
    CustomerModel.aggregate<{ _id: string; n: number }>([{ $match: { shopId: t.shopId, tier: { $nin: [null, ''] } } }, { $group: { _id: '$tier', n: { $sum: 1 } } }]),
    SaleModel.aggregate<{ _id: Types.ObjectId; spend: number; bills: number }>([{ $match: { shopId: t.shopId, customerId: { $ne: null }, billDate: { $gte: from, $lt: end }, ...live } }, { $group: { _id: '$customerId', spend: { $sum: '$grandTotal' }, bills: { $sum: 1 } } }, { $sort: { spend: -1 } }, { $limit: 10 }]),
    SaleModel.aggregate<{ _id: number; v: number }>([
      { $match: { shopId: t.shopId, dueAmount: { $gt: 0 }, ...live } },
      { $project: { dueAmount: 1, age: { $divide: [{ $subtract: [now, '$billDate'] }, DAY] } } },
      { $group: { _id: { $switch: { branches: [{ case: { $lte: ['$age', 30] }, then: 0 }, { case: { $lte: ['$age', 60] }, then: 1 }, { case: { $lte: ['$age', 90] }, then: 2 }], default: 3 } }, v: { $sum: '$dueAmount' } } },
    ]),
    CustomerModel.aggregate<{ p: number }>([{ $match: { shopId: t.shopId } }, { $group: { _id: null, p: { $sum: '$loyaltyPoints' } } }]),
    LoyaltyModel.aggregate<{ _id: string; p: number }>([{ $match: { shopId: t.shopId, createdAt: { $gte: new Date(istDayStart(now).getTime() - 89 * DAY) } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, p: { $sum: '$points' } } }]),
  ]);
  const first = new Map(firsts.map((f) => [String(f._id), f.first]));
  const weeks = Math.max(1, Math.ceil((end.getTime() - from.getTime()) / (7 * DAY)));
  const growth = Array.from({ length: weeks }, (_, w) => ({ week: istIsoDay(new Date(from.getTime() + w * 7 * DAY)), fresh: 0, repeat: 0 }));
  for (const r of inRange) {
    const g = growth[r._id.w];
    const f = first.get(String(r._id.c));
    if (!g || !f) continue;
    // New = their first bill ever falls in this week.
    if (f.getTime() >= from.getTime() + r._id.w * 7 * DAY && f.getTime() < from.getTime() + (r._id.w + 1) * 7 * DAY) g.fresh++;
    else g.repeat++;
  }
  const names = new Map((await CustomerModel.find({ shopId: t.shopId, _id: { $in: top.map((x) => x._id) } }).select('name tier').lean()).map((c) => [String(c._id), c]));
  let p = points[0]?.p ?? 0;
  const liability: { day: string; points: number }[] = [];
  for (let i = 0; i < 90; i++) {
    const d = istIsoDay(new Date(istDayStart(now).getTime() - i * DAY));
    liability.unshift({ day: d, points: p });
    p -= ledger.find((x) => x._id === d)?.p ?? 0;
  }
  const label = ['0–30 days', '31–60', '61–90', '90+'];
  return {
    growth,
    tiers: tiers.map((x) => ({ key: x._id, value: x.n })),
    customers: top.map((x) => ({ id: String(x._id), name: names.get(String(x._id))?.name ?? '', tier: names.get(String(x._id))?.tier ?? '', spend: x.spend, bills: x.bills })),
    credit: label.map((l, i) => ({ key: l, value: credit.find((c) => c._id === i)?.v ?? 0 })),
    liability,
  };
}

async function suppliersTab(t: TenantContext, from: Date, to: Date) {
  const end = new Date(to.getTime() + DAY);
  const [bySupplier, returns, batches] = await Promise.all([
    PurchaseModel.aggregate<{ _id: string; v: number }>([{ $match: { shopId: t.shopId, status: 'active', invoiceDate: { $gte: from, $lt: end } } }, { $group: { _id: '$supplierName', v: { $sum: '$grandTotal' } } }, { $sort: { v: -1 } }, { $limit: 12 }]),
    PurchaseReturnModel.aggregate<{ _id: string; v: number }>([{ $match: { shopId: t.shopId, returnDate: { $gte: from, $lt: end } } }, { $group: { _id: '$supplierName', v: { $sum: '$total' } } }, { $sort: { v: -1 } }]),
    // The last two batches bought per product, to see a rate move.
    BatchModel.aggregate<{ _id: Types.ObjectId; b: { cost: number; salePack: number; at: Date }[] }>([
      { $match: { shopId: t.shopId } },
      { $sort: { receivedAt: -1 } },
      { $group: { _id: '$productId', b: { $push: { cost: '$costPerBaseUnit', salePack: '$salePack', at: '$receivedAt' } } } },
      { $project: { b: { $slice: ['$b', 2] } } },
    ]),
  ]);
  const moved = batches.filter((x) => x.b.length === 2 && x.b[0] && x.b[1] && x.b[0].cost !== x.b[1].cost);
  const names = new Map((await ProductModel.find({ shopId: t.shopId, _id: { $in: moved.map((x) => x._id) } }).select('name').lean()).map((p) => [String(p._id), p.name]));
  const rates = moved
    .map((x) => {
      const [now, before] = x.b;
      const a = (before?.cost ?? 0) * (before?.salePack ?? 1);
      const b = (now?.cost ?? 0) * (now?.salePack ?? 1);
      return { name: names.get(String(x._id)) ?? '', before: a, now: b, pct: a ? Math.round(((b - a) * 1000) / a) / 10 : 0 };
    })
    .sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct))
    .slice(0, 10);
  return { bySupplier: bySupplier.map((x) => ({ key: x._id, value: x.v })), returns: returns.map((x) => ({ key: x._id, value: x.v })), rates };
}

export async function analytics(t: TenantContext, userId: string, tab: Tab, from: Date, to: Date, now = new Date()) {
  if (tab === 'stock') return { tab, ...(await stockTab(t, userId, from, to, now)) };
  if (tab === 'customers') return { tab, ...(await customersTab(t, from, to, now)) };
  if (tab === 'suppliers') return { tab, ...(await suppliersTab(t, from, to)) };
  return { tab, ...(await salesTab(t, userId, from, to)) };
}
