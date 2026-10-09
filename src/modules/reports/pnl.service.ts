import type { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { ExpenseModel } from '../expenses/expense.model';
import { PurchaseModel } from '../purchases/purchase.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import { ShopModel } from '../shops/shop.model';
import { MovementModel } from '../stock/movement.model';

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;
const TZ = 'Asia/Kolkata';
const LOSS = ['EXPIRY_WRITE_OFF', 'DAMAGE'];

const dayKey = (field: string) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ } });
const zero = (field: string) => ({ $ifNull: [field, 0] });

/** Sums per IST day (or one row, `_id: null`) — every P&L number comes from these, so the day book adds up to the P&L. */
async function parts(shopId: Types.ObjectId, from: Date, to: Date, byDay: boolean) {
  const key = (f: string) => (byDay ? dayKey(f) : null);
  const [sales, returns, expenses, losses, purchases] = await Promise.all([
    SaleModel.aggregate<{ _id: string | null; bills: number; total: number; taxable: number; tax: number; cost: number; points: number }>([
      { $match: { shopId, billDate: { $gte: from, $lt: to }, status: { $ne: 'cancelled' } } },
      { $group: { _id: key('$billDate'), bills: { $sum: 1 }, total: { $sum: '$grandTotal' }, taxable: { $sum: '$taxableAmount' }, tax: { $sum: '$totalTax' }, cost: { $sum: '$totalCost' }, points: { $sum: zero('$loyaltyDiscountAmount') } } },
    ]),
    SaleReturnModel.aggregate<{ _id: string | null; n: number; total: number; taxable: number; tax: number; cost: number; points: number }>([
      { $match: { shopId, returnDate: { $gte: from, $lt: to } } },
      { $group: { _id: key('$returnDate'), n: { $sum: 1 }, total: { $sum: '$total' }, taxable: { $sum: '$taxableAmount' }, tax: { $sum: '$totalTax' }, cost: { $sum: '$totalCost' }, points: { $sum: zero('$loyaltyRestoredValue') } } },
    ]),
    ExpenseModel.aggregate<{ _id: { d: string | null; c: string }; total: number }>([
      { $match: { shopId, status: 'active', date: { $gte: from, $lt: to } } },
      { $group: { _id: { d: key('$date'), c: '$category' }, total: { $sum: '$amount' } } },
    ]),
    MovementModel.aggregate<{ _id: string | null; value: number; n: number }>([
      { $match: { shopId, type: { $in: LOSS }, at: { $gte: from, $lt: to } } },
      { $group: { _id: key('$at'), value: { $sum: { $multiply: [{ $subtract: [0, '$quantity'] }, '$costPerBaseUnit'] } }, n: { $sum: 1 } } },
    ]),
    PurchaseModel.aggregate<{ _id: string | null; n: number; total: number; tax: number }>([
      { $match: { shopId, status: 'active', invoiceDate: { $gte: from, $lt: to } } },
      { $group: { _id: key('$invoiceDate'), n: { $sum: 1 }, total: { $sum: '$grandTotal' }, tax: { $sum: { $add: ['$cgst', '$sgst'] } } } },
    ]),
  ]);
  return { sales, returns, expenses, losses, purchases };
}

type Parts = Awaited<ReturnType<typeof parts>>;

/** PLAN §35.6 — one definition of net profit everywhere: gross − expenses − write-offs − points customers paid with. */
function compute(p: Parts, day: string | null) {
  const pick = <T extends { _id: unknown }>(rows: T[]) => rows.find((r) => r._id === day);
  const s = pick(p.sales);
  const r = pick(p.returns);
  const w = pick(p.losses);
  const b = pick(p.purchases);
  const ex = p.expenses.filter((e) => e._id.d === day);
  const byCategory = new Map<string, number>();
  for (const e of ex) byCategory.set(e._id.c, (byCategory.get(e._id.c) ?? 0) + e.total);
  const revenue = (s?.taxable ?? 0) - (r?.taxable ?? 0);
  const cogs = (s?.cost ?? 0) - (r?.cost ?? 0);
  const gross = revenue - cogs;
  const expenses = ex.reduce((a, e) => a + e.total, 0);
  const writeOff = w?.value ?? 0;
  const points = (s?.points ?? 0) - (r?.points ?? 0);
  return {
    bills: s?.bills ?? 0,
    sales: s?.total ?? 0,
    salesTaxable: s?.taxable ?? 0,
    salesGst: s?.tax ?? 0,
    returns: r?.total ?? 0,
    returnCount: r?.n ?? 0,
    returnsTaxable: r?.taxable ?? 0,
    returnsGst: r?.tax ?? 0,
    salesCost: s?.cost ?? 0,
    returnsCost: r?.cost ?? 0,
    revenue,
    cogs,
    gross,
    grossPct: revenue ? Math.round((gross * 10_000) / revenue) / 100 : 0,
    expenses,
    byCategory: [...byCategory.entries()].map(([category, total]) => ({ category, total })).sort((a, c) => c.total - a.total),
    writeOff,
    writeOffEntries: w?.n ?? 0,
    pointsUsed: s?.points ?? 0,
    pointsBack: r?.points ?? 0,
    points,
    purchases: b?.total ?? 0,
    purchaseGst: b?.tax ?? 0,
    purchaseCount: b?.n ?? 0,
    net: gross - expenses - writeOff - points,
  };
}

/** `from` and `to` are 00:00 IST of the first and last day; the last day counts in full. */
export async function pnl(t: TenantContext, from: Date, to: Date) {
  return { from: istIsoDay(from), to: istIsoDay(to), ...compute(await parts(t.shopId, from, new Date(to.getTime() + DAY), false), null) };
}

/** The same P&L for every day of a range, read in one pass (oldest first). */
export async function pnlByDay(t: TenantContext, from: Date, to: Date) {
  const p = await parts(t.shopId, from, new Date(to.getTime() + DAY), true);
  const out = [];
  for (let d = from; d <= to; d = new Date(d.getTime() + DAY)) out.push({ day: istIsoDay(d), ...compute(p, istIsoDay(d)) });
  return out;
}

const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1) - IST);

/** The last 4 months; a month before the shop started is "partial", the running month is "so far". */
export async function months(t: TenantContext, now = new Date()) {
  const ist = new Date(now.getTime() + IST);
  const shop = await ShopModel.findById(t.shopId).select('createdAt').lean<{ createdAt?: Date }>();
  const started = shop?.createdAt ? new Date(Math.floor((shop.createdAt.getTime() + IST) / DAY) * DAY - IST) : new Date(0);
  const backs = [3, 2, 1, 0];
  const all = await Promise.all(backs.map((back) => parts(t.shopId, monthStart(ist.getUTCFullYear(), ist.getUTCMonth() - back), monthStart(ist.getUTCFullYear(), ist.getUTCMonth() - back + 1), false)));
  return backs.map((back, i) => {
    const a = monthStart(ist.getUTCFullYear(), ist.getUTCMonth() - back);
    const p = compute(all[i] as Parts, null);
    const partial = a < started;
    return { month: istIsoDay(a).slice(0, 7), current: back === 0, partial, closed: back > 0 && !partial, revenue: p.revenue, gross: p.gross, grossPct: p.grossPct, expenses: p.expenses, writeOff: p.writeOff, points: p.points, net: p.net };
  });
}

/** PLAN §35.6 day book: every day of a month (to today) — its total row is the month's P&L to the paisa. */
export async function daybook(t: TenantContext, month: string, now = new Date()) {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const a = monthStart(y, m - 1);
  const b = monthStart(y, m);
  const [p, whole] = await Promise.all([parts(t.shopId, a, b, true), parts(t.shopId, a, b, false)]);
  const today = istIsoDay(now);
  const days = [];
  for (let d = a; d < b; d = new Date(d.getTime() + DAY)) {
    const key = istIsoDay(d);
    if (key > today) break;
    const c = compute(p, key);
    days.push({ day: key, bills: c.bills, sales: c.sales, returns: c.returns, purchases: c.purchases, gross: c.gross, expenses: c.expenses, writeOff: c.writeOff, points: c.points, net: c.net });
  }
  const total = compute(whole, null);
  return { month, days, total: { bills: total.bills, sales: total.sales, returns: total.returns, purchases: total.purchases, gross: total.gross, expenses: total.expenses, writeOff: total.writeOff, points: total.points, net: total.net } };
}
