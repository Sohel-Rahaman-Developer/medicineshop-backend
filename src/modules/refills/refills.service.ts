import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { CustomerModel } from '../customers/customer.model';
import { ProductModel } from '../products/product.model';
import { SaleModel } from '../sales/sale.model';
import type { Actor } from '../user/actor';
import { RefillMarkModel } from './refill.model';

// D103: who is due to come back for a medicine they buy again and again — worked out from the shop's own bills, by
// rule (no AI): a regular buys the same medicine on 2+ days with a steady gap; due = last purchase + that gap.

const DAY = 86_400_000;
export const RULE = { lookBackDays: 180, minGap: 14, maxGap: 120, soonDays: 3, giveUpDays: 60, quietDays: 7 } as const;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : Math.round(((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2);
};

export async function due(t: TenantContext, now = new Date()) {
  const rows = await SaleModel.aggregate<{ _id: { c: Types.ObjectId; p: Types.ObjectId }; product: string; pack: number; buys: { at: Date; base: number }[] }>([
    { $match: { shopId: t.shopId, customerId: { $ne: null }, billDate: { $gte: new Date(now.getTime() - RULE.lookBackDays * DAY) }, status: { $ne: 'cancelled' } } },
    { $unwind: '$lines' },
    // One purchase per IST day: two bills on the same day are one visit.
    { $group: { _id: { c: '$customerId', p: '$lines.productId', d: { $dateToString: { format: '%Y-%m-%d', date: '$billDate', timezone: '+05:30' } } }, product: { $last: '$lines.productName' }, pack: { $last: '$lines.salePack' }, at: { $max: '$billDate' }, base: { $sum: '$lines.quantityInBase' } } },
    { $sort: { at: 1 } },
    { $group: { _id: { c: '$_id.c', p: '$_id.p' }, product: { $last: '$product' }, pack: { $last: '$pack' }, buys: { $push: { at: '$at', base: '$base' } } } },
    { $match: { 'buys.1': { $exists: true } } },
  ]);
  const found = rows.flatMap((r) => {
    const days = r.buys.map((b) => Math.floor(b.at.getTime() / DAY));
    const every = median(days.slice(1).map((d, i) => d - (days[i] ?? d)));
    if (every < RULE.minGap || every > RULE.maxGap) return [];
    const last = r.buys.at(-1);
    if (!last) return [];
    const dueOn = new Date(last.at.getTime() + every * DAY);
    const late = Math.floor((now.getTime() - dueOn.getTime()) / DAY);
    if (late < -RULE.soonDays || late > RULE.giveUpDays) return [];
    return [{ customerId: r._id.c, productId: r._id.p, product: r.product, every, buys: r.buys.length, lastBought: last.at, lastPacks: Math.round((last.base / Math.max(1, r.pack)) * 10) / 10, dueOn, late }];
  });
  if (!found.length) return { rule: RULE, due: 0, reminded: 0, rows: [] };
  const [customers, products, marks] = await Promise.all([
    CustomerModel.find({ shopId: t.shopId, _id: { $in: [...new Set(found.map((f) => String(f.customerId)))].map((id) => new Types.ObjectId(id)) } }).select('name phone').lean(),
    ProductModel.find({ shopId: t.shopId, isActive: true, _id: { $in: [...new Set(found.map((f) => String(f.productId)))].map((id) => new Types.ObjectId(id)) } }).select('name units stock').lean(),
    RefillMarkModel.find({ shopId: t.shopId, customerId: { $in: found.map((f) => f.customerId) } }).lean(),
  ]);
  const cust = new Map(customers.map((c) => [String(c._id), c]));
  const prod = new Map(products.map((p) => [String(p._id), p]));
  const mark = new Map(marks.map((m) => [`${String(m.customerId)}:${String(m.productId)}`, m]));
  const out = found.flatMap((f) => {
    const c = cust.get(String(f.customerId));
    const p = prod.get(String(f.productId));
    const m = mark.get(`${String(f.customerId)}:${String(f.productId)}`);
    if (!c || !p || m?.stopped) return [];
    // A reminder after the last purchase quiets the row for a week; then it shows again if they still haven't come.
    const reminded = m?.remindedAt && m.remindedAt > f.lastBought && now.getTime() - m.remindedAt.getTime() < RULE.quietDays * DAY ? { at: m.remindedAt, by: m.remindedBy, how: m.how } : null;
    return [{ customerId: String(f.customerId), name: c.name, phone: c.phone, productId: String(f.productId), product: p.name, unit: (p.units as { sale: string }).sale, inStock: p.stock.sellable > 0, every: f.every, buys: f.buys, lastBought: f.lastBought, lastPacks: f.lastPacks, dueOn: f.dueOn, late: f.late, reminded }];
  });
  out.sort((a, b) => Number(Boolean(a.reminded)) - Number(Boolean(b.reminded)) || b.late - a.late || a.name.localeCompare(b.name));
  return { rule: RULE, due: out.filter((r) => !r.reminded).length, reminded: out.filter((r) => r.reminded).length, rows: out.slice(0, 200) };
}

export type RefillAction = { action: 'reminded'; how: 'whatsapp' | 'call' } | { action: 'stop' } | { action: 'resume' };

/** Reminded (WhatsApp or a call), "not a regular" for this medicine, or back on the list. */
export async function mark(t: TenantContext, actor: Actor, customerId: string, productId: string, a: RefillAction, now = new Date()) {
  const ids = { shopId: t.shopId, customerId: new Types.ObjectId(customerId), productId: new Types.ObjectId(productId) };
  if (!(await CustomerModel.exists({ shopId: t.shopId, _id: ids.customerId })) || !(await ProductModel.exists({ shopId: t.shopId, _id: ids.productId }))) throw AppError.notFound('Customer or medicine not found');
  const set = a.action === 'reminded' ? { remindedAt: now, remindedBy: actor.name, how: a.how } : a.action === 'stop' ? { stopped: true, stoppedBy: actor.name } : { stopped: false, stoppedBy: '' };
  await RefillMarkModel.updateOne(ids, { $set: set }, { upsert: true });
}
