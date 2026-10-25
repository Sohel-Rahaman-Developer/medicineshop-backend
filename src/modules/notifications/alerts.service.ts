import type { TenantContext } from '../../core/middleware/tenant';
import { dayLabel, istDayStart, istIsoDay, monthLabel } from '../../utils/date';
import { inr } from '../../utils/money';
import { CustomerModel } from '../customers/customer.model';
import { DayCloseModel } from '../dayclose/dayclose.model';
import { rulesOf } from '../loyalty/loyalty.service';
import * as orders from '../orders/orders.service';
import { ProductModel } from '../products/product.model';
import { can } from '../rbac/permissions';
import { SaleModel } from '../sales/sale.model';
import { AutopayModel } from '../subscription/billing.model';
import { ShopModel } from '../shops/shop.model';
import { BatchModel } from '../stock/batch.model';
import * as suppliers from '../suppliers/suppliers.service';
import { typeInfo, type Group, type NotificationType, type Priority } from './notification.catalog';

const DAY = 24 * 60 * 60 * 1000;
const rupees = (p: number) => inr(p).replace(/\.00$/, '');
// Whole sentences, one and many apart: each one is translated as it stands (core/lang).
const batchesTitle = (n: number, from: number | null, to: number) => {
  const c = n === 200 ? '200+' : String(n);
  if (from === null) return n === 1 ? '1 batch expired — take it off the shelf' : `${c} batches expired — take them off the shelf`;
  if (from) return n === 1 ? `1 batch expires in ${String(from + 1)}–${String(to)} days` : `${c} batches expire in ${String(from + 1)}–${String(to)} days`;
  return n === 1 ? `1 batch expires within ${String(to)} days` : `${c} batches expire within ${String(to)} days`;
};
const planTitle = (trial: boolean, n: number) => (trial ? (n === 1 ? 'Trial ends in 1 day' : `Trial ends in ${String(n)} days`) : n === 1 ? 'Plan renews in 1 day' : `Plan renews in ${String(n)} days`);
const summaryTitle = (today: boolean, n: number, total: string) => (today ? (n === 1 ? `Today: 1 bill · ${total}` : `Today: ${String(n)} bills · ${total}`) : n === 1 ? `Yesterday: 1 bill · ${total}` : `Yesterday: ${String(n)} bills · ${total}`);

export interface Alert {
  key: string;
  type: NotificationType;
  group: Group;
  priority: Priority;
  title: string;
  body: string;
  route: string;
  action: string;
  items: { text: string; sub: string }[];
  at: Date;
}

const alert = (type: NotificationType, a: Omit<Alert, 'type' | 'group' | 'items'> & { items?: Alert['items'] }): Alert => ({ type, group: typeInfo(type).group, items: [], ...a });

/** Owner and Manager get the money and shop-health alerts (sandbox: S.isOwner() || manager). */
const boss = (t: TenantContext) => t.isOwner || t.roleKey === 'owner' || t.roleKey === 'manager';
/** PLAN §17 / D22: expiry goes to Owner, Manager and Stock Keeper only — not by permission, not to custom roles. */
const expiryAudience = (t: TenantContext) => boss(t) || t.roleKey === 'stockKeeper';

export const DEFAULT_ALERT_DAYS = [90, 60, 30];

/** The shop's alert days → windows: expired, then (0, d1], (d1, d2]… — the nearest is the most urgent. */
export function expiryWindows(days: readonly number[]) {
  const d = [...new Set(days)].filter((x) => x > 0).sort((a, b) => a - b);
  const types: NotificationType[] = ['EXPIRY_SOON', 'EXPIRY_NEXT'];
  const prio: Priority[] = ['high', 'medium'];
  return [
    { type: 'EXPIRED' as NotificationType, priority: 'critical' as Priority, from: null, to: 0, what: 'expired — take them off the shelf', bucket: 'expired' },
    ...d.map((to, i) => {
      const from = i ? (d[i - 1] ?? 0) : 0;
      return { type: types[i] ?? 'EXPIRY_AHEAD', priority: prio[i] ?? 'low', from, to, what: from ? `expire in ${String(from + 1)}–${String(to)} days` : `expire within ${String(to)} days`, bucket: to <= 30 ? 'd30' : to <= 60 ? 'd60' : 'd90' };
    }),
  ];
}

/**
 * Alerts worked out from the shop as it is now, for this person (sandbox state.js S.notifications).
 * Keys carry the IST day, so tomorrow's alert is a fresh unread one.
 */
export async function liveAlerts(t: TenantContext, now: Date): Promise<Alert[]> {
  const day = istIsoDay(now);
  const at8 = new Date(istDayStart(now).getTime() + 8 * 60 * 60 * 1000);

  const s1 = async (): Promise<Alert[]> => {
    if (!expiryAudience(t)) return [];
    const shop = await ShopModel.findOne({ _id: t.shopId }).select('settings.inventory.expiryAlertDays').lean();
    const days = shop?.settings.inventory?.expiryAlertDays;
    const found = await Promise.all(expiryWindows(days?.length ? days : DEFAULT_ALERT_DAYS).map(async ({ type, priority, from, to, bucket }): Promise<Alert[]> => {
      const at = (n: number) => new Date(now.getTime() + n * DAY);
      const expiryDate = from === null ? { $lt: now } : { [from ? '$gt' : '$gte']: from ? at(from) : now, $lte: at(to) };
      const match = { shopId: t.shopId, status: 'active' as const, quantity: { $gt: 0 }, expiryDate };
      const rows = await BatchModel.find(match).sort({ expiryDate: 1 }).select('productId batchNumber expiryDate').limit(200).lean();
      if (!rows.length) return [];
      const names = new Map((await ProductModel.find({ shopId: t.shopId, _id: { $in: rows.slice(0, 3).map((b) => b.productId) } }).select('name').lean()).map((p) => [String(p._id), p.name]));
      return [
        alert(type, {
          key: `${type}:${String(to)}:${day}`,
          priority,
          title: batchesTitle(rows.length, from, to),
          body: from === null ? 'Expired stock can’t be sold. Return it to the supplier or write it off.' : 'Sell these first or return them to the supplier in time.',
          route: `/expiry?bucket=${bucket}`,
          action: 'Open expiry',
          items: rows.slice(0, 3).map((b) => ({ text: names.get(String(b.productId)) ?? '', sub: `Batch ${b.batchNumber} · exp ${monthLabel(b.expiryDate)}` })),
          at: at8,
        }),
      ];
    }));
    return found.flat();
  };

  const s2 = async (): Promise<Alert[]> => {
    if (!can(t.permissions, 'stock', 'view')) return [];
    const found = await Promise.all(([['out', 'STOCK_OUT', 'high'], ['low', 'STOCK_LOW', 'medium']] as const).map(async ([status, type, priority]): Promise<Alert[]> => {
      const rows = await ProductModel.find({ shopId: t.shopId, isActive: true, 'stock.status': status }).sort({ lastSoldAt: -1 }).select('name company').limit(300).lean();
      if (!rows.length) return [];
      return [
        alert(type, {
          key: `${type}:${day}`,
          priority,
          title: status === 'out' ? (rows.length === 1 ? '1 product out of stock' : `${String(rows.length)} products out of stock`) : rows.length === 1 ? '1 product below reorder level' : `${String(rows.length)} products below reorder level`,
          body: status === 'out' ? 'Customers are being turned away — reorder the fast movers first.' : 'Suggested quantities are on the reorder list.',
          route: '/reorder',
          action: 'Reorder list',
          items: rows.slice(0, 3).map((p) => ({ text: p.name, sub: p.company })),
          at: at8,
        }),
      ];
    }));
    return found.flat();
  };

  const s3 = async (): Promise<Alert[]> => {
    const out: Alert[] = [];
    if (!can(t.permissions, 'suppliers', 'view')) return out;
    const due = await suppliers.summary(t);
    if (due.dueThisWeek) {
      out.push(alert('SUPPLIER_DUE', { key: `SUPPLIER_DUE:${day}`, priority: due.overdue ? 'high' : 'medium', title: `${rupees(due.dueThisWeek)} due to suppliers this week`, body: due.overdue ? `${rupees(due.overdue)} of it is already overdue.` : 'Nothing overdue yet.', route: '/suppliers', action: 'Open suppliers', at: at8 }));
    }
    return out;
  };

  const s4 = async (): Promise<Alert[]> => {
    const out: Alert[] = [];
    if (!(can(t.permissions, 'customers', 'view') && (boss(t) || t.roleKey === 'accountant'))) return out;
    const ids = await SaleModel.distinct('customerId', { shopId: t.shopId, status: { $ne: 'cancelled' }, dueAmount: { $gt: 0 }, billDate: { $lt: new Date(now.getTime() - 30 * DAY) } });
    // Old khata udhaar counts from the day it was written down as owed.
    const late = await CustomerModel.find({ shopId: t.shopId, creditBalance: { $gt: 0 }, $or: [{ _id: { $in: ids } }, { oldDue: { $gt: 0 }, oldDueSince: { $lt: new Date(now.getTime() - 30 * DAY) } }] }).sort({ creditBalance: -1 }).select('name creditBalance').lean();
    if (late.length) {
      out.push(
        alert('UDHAAR_OVERDUE', {
          key: `UDHAAR_OVERDUE:${day}`,
          priority: 'medium',
          title: late.length === 1 ? '1 customer owes udhaar older than 30 days' : `${String(late.length)} customers owe udhaar older than 30 days`,
          body: `${rupees(late.reduce((s, c) => s + c.creditBalance, 0))} outstanding. A reminder usually brings it back.`,
          route: '/credit',
          action: 'Open udhaar',
          items: late.slice(0, 3).map((c) => ({ text: c.name, sub: rupees(c.creditBalance) })),
          at: at8,
        }),
      );
    }
    return out;
  };

  const s5 = async (): Promise<Alert[]> => {
    const out: Alert[] = [];
    if (!boss(t)) return out;
    // End-of-day summary: today's after 22:00 IST, otherwise yesterday's (sandbox).
    const late = now.getTime() - istDayStart(now).getTime() >= 22 * 60 * 60 * 1000;
    const d0 = late ? istDayStart(now) : new Date(istDayStart(now).getTime() - DAY);
    const y0 = new Date(istDayStart(now).getTime() - DAY);
    const yDay = istIsoDay(y0);
    const [shop, auto, bills, closes, soldYesterday, closedYesterday] = await Promise.all([
      ShopModel.findOne({ _id: t.shopId }).select('drugLicenseExpiry settings.loyalty').lean(),
      AutopayModel.findOne({ shopId: t.shopId, status: { $in: ['pending', 'halted'] } }).select('status').lean(),
      SaleModel.find({ shopId: t.shopId, status: { $ne: 'cancelled' }, billDate: { $gte: d0, $lt: new Date(d0.getTime() + DAY) } }).select('grandTotal payments').lean(),
      DayCloseModel.find({ shopId: t.shopId, diff: { $lte: -10_000 }, at: { $gte: new Date(now.getTime() - 7 * DAY) } }).select('day diff counted expected byName note at').lean(),
      SaleModel.exists({ shopId: t.shopId, billDate: { $gte: y0, $lt: istDayStart(now) } }),
      DayCloseModel.exists({ shopId: t.shopId, day: yDay }),
    ]);
    if (shop && t.features.includes('loyalty') && !rulesOf(shop.settings.loyalty).configured) {
      out.push(alert('LOYALTY_SETUP', { key: 'LOYALTY_SETUP', priority: 'medium', title: 'Loyalty points are not set up', body: 'Decide what a point is worth — until then customers earn no points.', route: '/loyalty', action: 'Set up points', at: at8 }));
    }
    const dl = shop ? Math.ceil((shop.drugLicenseExpiry.getTime() - now.getTime()) / DAY) : 999;
    if (dl < 0) out.push(alert('DL_EXPIRY', { key: `DL_EXPIRED:${day}`, priority: 'critical', title: `Drug licence expired on ${dayLabel(shop?.drugLicenseExpiry ?? now)}`, body: 'Selling medicines needs a valid licence. Update it in Settings → Shop profile.', route: '/settings', action: 'Update licence', at: at8 }));
    else if (dl <= 60) out.push(alert('DL_EXPIRY', { key: `DL_SOON:${day}`, priority: 'high', title: dl === 1 ? 'Drug licence expires in 1 day' : `Drug licence expires in ${String(dl)} days`, body: `On ${dayLabel(shop?.drugLicenseExpiry ?? now)}. Apply for renewal now — it takes weeks.`, route: '/settings', action: 'Shop profile', at: at8 }));

    const sub = t.subscription;
    const left = Math.ceil((sub.endDate.getTime() - now.getTime()) / DAY);
    if (sub.status === 'expired' || sub.status === 'cancelled') out.push(alert('SUBSCRIPTION_EXPIRED', { key: `SUBSCRIPTION_EXPIRED:${day}`, priority: 'critical', title: sub.status === 'expired' ? 'Subscription expired — read-only' : 'Subscription cancelled — read-only', body: 'Your data is safe. Renew to start billing again.', route: '/settings/plan', action: 'Renew', at: at8 }));
    else if (sub.status === 'grace' || left <= 7) out.push(alert('SUBSCRIPTION_EXPIRING', { key: `SUBSCRIPTION_EXPIRING:${day}`, priority: 'high', title: sub.status === 'grace' ? 'Plan ended · grace period' : planTitle(sub.status === 'trial', Math.max(0, left)), body: `On ${dayLabel(sub.endDate)}.`, route: '/settings/plan', action: 'Choose a plan', at: at8 }));

    // B8c: a failed autopay charge — Razorpay retries (pending), then gives up (halted); the plan screen has the fix.
    if (auto) out.push(alert('SUBSCRIPTION_EXPIRING', { key: `AUTOPAY_${auto.status.toUpperCase()}:${day}`, priority: 'high', title: auto.status === 'pending' ? 'Autopay payment failed' : 'Autopay stopped after failed payments', body: auto.status === 'pending' ? 'Razorpay will try again. Keep money in the account, or pay once so the shop never stops.' : 'Pay once, or turn autopay on again, before the plan ends.', route: '/settings/plan', action: 'Open plan', at: at8 }));

    if (bills.length) {
      const modes = new Map<string, number>();
      for (const b of bills) for (const p of b.payments) modes.set(p.mode, (modes.get(p.mode) ?? 0) + p.amount);
      out.push(
        alert('DAILY_SUMMARY', {
          key: `DAILY_SUMMARY:${istIsoDay(d0)}`,
          priority: 'low',
          title: summaryTitle(late, bills.length, rupees(bills.reduce((s, b) => s + b.grandTotal, 0))),
          body: 'Match the cash drawer with the cash line.',
          route: '/sales',
          action: 'Open sales',
          items: [...modes.entries()].sort((a, b) => b[1] - a[1]).map(([m, v]) => ({ text: m === 'CREDIT' ? 'Udhaar' : m === 'POINTS' ? 'Points' : m.charAt(0) + m.slice(1).toLowerCase(), sub: rupees(v) })),
          at: late ? now : at8,
        }),
      );
    }

    for (const c of closes) {
      out.push(alert('CASH_SHORT', { key: `CASH_SHORT:${String(c._id)}`, priority: 'high', title: `Cash short ${rupees(-c.diff)} on ${c.day}`, body: c.note ? `Counted ${rupees(c.counted)}, expected ${rupees(c.expected)} · closed by ${c.byName} · “${c.note}”` : `Counted ${rupees(c.counted)}, expected ${rupees(c.expected)} · closed by ${c.byName}`, route: '/day-close', action: 'See the day', at: c.at }));
    }
    if (soldYesterday && !closedYesterday) {
      out.push(alert('CASH_SHORT', { key: `DAY_OPEN:${day}`, priority: 'medium', title: 'Yesterday’s cash was not closed', body: `Count the drawer and close ${yDay} before today’s cash mixes in.`, route: '/day-close', action: 'Close the day', at: at8 }));
    }
    return out;
  };

  const s6 = async (): Promise<Alert[]> => {
    const out: Alert[] = [];
    if (!can(t.permissions, 'pos', 'create')) return out;
    const o = await orders.summary(t);
    if (o.ready) out.push(alert('ORDER_READY', { key: `ORDER_READY:${day}:${String(o.ready)}`, priority: 'high', title: o.ready === 1 ? '1 customer order is ready — call them' : `${String(o.ready)} customer orders are ready — call them`, body: 'The stock has come in. Bill it from Orders when they arrive — the advance is taken off.', route: '/orders', action: 'Open orders', at: now }));
    if (o.stale && boss(t)) out.push(alert('ORDER_READY', { key: `ORDER_STALE:${day}`, priority: 'medium', title: o.stale === 1 ? '1 order not collected for over 10 days' : `${String(o.stale)} orders not collected for over 10 days`, body: `${rupees(o.advanceHeld)} of advance is held on open orders. Call, or cancel and refund.`, route: '/orders', action: 'Open orders', at: at8 }));
    return out;
  };
  return (await Promise.all([s1(), s2(), s3(), s4(), s5(), s6()])).flat();
}
