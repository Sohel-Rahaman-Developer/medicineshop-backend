import { Types, type ClientSession } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { inr, rhu } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { CustomerModel } from '../customers/customer.model';
import { ShopModel } from '../shops/shop.model';
import type { Actor } from '../user/actor';
import { DEFAULT_RULES, earn, expiryOf, nextTier, redeemCap, shareOf, tierFor, type LoyaltyRules } from './loyalty.domain';
import { LoyaltyModel, type LoyaltyType } from './loyalty.model';
import type { AdjustInput, LoyaltyListQuery, RulesInput } from './loyalty.validation';

const DAY = 24 * 60 * 60 * 1000;
const oid = (id: string) => new Types.ObjectId(id);

/** Older shops have no loyalty section yet: the PLAN defaults fill it in, points off. */
export function rulesOf(raw: unknown): LoyaltyRules {
  const r = (raw ?? {}) as Partial<LoyaltyRules>;
  const tiers = r.tiers?.length ? r.tiers.map((x) => ({ name: x.name, minLifetimePoints: x.minLifetimePoints, earnMultiplier: x.earnMultiplier })) : DEFAULT_RULES.tiers;
  return { ...DEFAULT_RULES, ...r, excludedCategories: [...(r.excludedCategories ?? [])], tiers };
}

export async function rules(t: TenantContext, session?: ClientSession) {
  const shop = await ShopModel.findOne({ _id: t.shopId }).select('settings.loyalty').session(session ?? null).lean();
  return rulesOf(shop?.settings.loyalty);
}

interface Who {
  _id: Types.ObjectId;
  name: string;
}

interface Entry {
  type: LoyaltyType;
  points: number;
  refType: 'SALE' | 'RETURN' | 'MANUAL' | 'SIGNUP' | 'BIRTHDAY' | 'SYSTEM';
  refId?: Types.ObjectId;
  refNumber?: string;
  reason?: string;
  actor: { id?: string; name: string };
  at: Date;
}

/**
 * The only way points move (PLAN §16: never a direct edit). A credit is a new FIFO lot; a debit eats the oldest lots.
 * The customer's balance is guarded, so two counters can't spend the same points.
 */
async function post(t: TenantContext, c: Who, e: Entry, r: LoyaltyRules, session: ClientSession) {
  const p = e.points;
  const inc: Record<string, number> = { loyaltyPoints: p };
  if (e.type === 'EARN' || e.type === 'MANUAL_ADD' || e.type === 'SIGNUP' || e.type === 'BIRTHDAY') inc.lifetimePointsEarned = p;
  if (e.type === 'REDEEM') inc.lifetimePointsRedeemed = -p;
  // A reversal undoes what it reverses: earned points come off lifetime earned, redeemed ones off lifetime redeemed.
  if (e.type === 'REVERSAL') inc[p < 0 ? 'lifetimePointsEarned' : 'lifetimePointsRedeemed'] = p < 0 ? p : -p;
  const after = await CustomerModel.findOneAndUpdate({ shopId: t.shopId, _id: c._id, ...(p < 0 ? { loyaltyPoints: { $gte: -p } } : {}) }, { $inc: inc }, { session, returnDocument: 'after' })
    .select('loyaltyPoints lifetimePointsEarned tier')
    .lean();
  if (!after) throw AppError.conflict(`${c.name}'s points changed meanwhile — reload`, { reason: 'POINTS_CHANGED' });
  if (p < 0 && e.type !== 'EXPIRE') await consume(t, c, -p, session);
  const tier = tierFor(after.lifetimePointsEarned, r.tiers)?.name ?? '';
  if (tier !== after.tier) await CustomerModel.updateOne({ shopId: t.shopId, _id: c._id }, { $set: { tier } }, { session });
  await LoyaltyModel.create(
    [
      {
        shopId: t.shopId,
        customerId: c._id,
        customerName: c.name,
        type: e.type,
        points: p,
        balanceAfter: after.loyaltyPoints,
        ...(p > 0 ? { remaining: p, expiresAt: expiryOf(e.at, r.pointExpiryMonths) } : {}),
        refType: e.refType,
        refId: e.refId,
        refNumber: e.refNumber ?? '',
        reason: e.reason ?? '',
        userId: e.actor.id ? oid(e.actor.id) : undefined,
        userName: e.actor.name,
      },
    ],
    { session },
  );
  return { balance: after.loyaltyPoints, tier, tierBefore: after.tier };
}

/** Oldest lots first; the read value is the guard, so a lot is never spent twice. */
async function consume(t: TenantContext, c: Who, need: number, session: ClientSession) {
  const lots = await LoyaltyModel.find({ shopId: t.shopId, customerId: c._id, remaining: { $gt: 0 } }).sort({ createdAt: 1, _id: 1 }).select('remaining').session(session).lean();
  let left = need;
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(left, l.remaining ?? 0);
    const done = await LoyaltyModel.updateOne({ shopId: t.shopId, _id: l._id, remaining: l.remaining }, { $inc: { remaining: -take } }, { session });
    if (!done.modifiedCount) throw AppError.conflict(`${c.name}'s points changed meanwhile — reload`, { reason: 'POINTS_CHANGED' });
    left -= take;
  }
  if (left > 0) throw AppError.internal('The points ledger is out of step with the balance');
}

/** Lots past their date go in one EXPIRE entry; returns the balance left. */
export async function expire(t: TenantContext, c: Who, now: Date, r: LoyaltyRules, session: ClientSession) {
  const lots = await LoyaltyModel.find({ shopId: t.shopId, customerId: c._id, remaining: { $gt: 0 }, expiresAt: { $lt: now } }).select('remaining').session(session).lean();
  let total = 0;
  for (const l of lots) {
    const done = await LoyaltyModel.updateOne({ shopId: t.shopId, _id: l._id, remaining: l.remaining }, { $set: { remaining: 0 } }, { session });
    if (!done.modifiedCount) throw AppError.conflict(`${c.name}'s points changed meanwhile — reload`, { reason: 'POINTS_CHANGED' });
    total += l.remaining ?? 0;
  }
  if (total) {
    const months = r.pointExpiryMonths;
    return (await post(t, c, { type: 'EXPIRE', points: -total, refType: 'SYSTEM', reason: `Points older than ${String(months)} ${months === 1 ? 'month' : 'months'}`, actor: { name: 'System' }, at: now }, r, session)).balance;
  }
  const cur = await CustomerModel.findOne({ shopId: t.shopId, _id: c._id }).select('loyaltyPoints').session(session).lean();
  return cur?.loyaltyPoints ?? 0;
}

/** Until the nightly job (PLAN §16) ships, lists and summaries expire what is due first, one customer per transaction. */
export async function expireDue(t: TenantContext, now = new Date()) {
  const ids = await LoyaltyModel.distinct('customerId', { shopId: t.shopId, remaining: { $gt: 0 }, expiresAt: { $lt: now } });
  if (!ids.length) return;
  const r = await rules(t);
  const people = await CustomerModel.find({ shopId: t.shopId, _id: { $in: ids } }).select('name').lean();
  for (const c of people) await inTransaction((s) => expire(t, c, now, r, s));
}

export async function expireOne(t: TenantContext, customerId: Types.ObjectId) {
  if (!(await LoyaltyModel.exists({ shopId: t.shopId, customerId, remaining: { $gt: 0 }, expiresAt: { $lt: new Date() } }))) return;
  const c = await CustomerModel.findOne({ shopId: t.shopId, _id: customerId }).select('name').lean();
  if (!c) return;
  const r = await rules(t);
  await inTransaction((s) => expire(t, c, new Date(), r, s));
}

type BillCustomer = Who & { loyaltyPoints: number; lifetimePointsEarned: number; tier: string };
type BillLine = { category: string; totalAmount: number };

export const earnsPoints = (category: string, r: LoyaltyRules) => !r.excludedCategories.includes(category);

/**
 * A bill's points (PLAN §16): redeem within the cap, earn on what the customer pays.
 * Excluded categories earn nothing; the earn base is their share of the bill.
 */
export async function forBill(t: TenantContext, r: LoyaltyRules, c: BillCustomer | null, o: { redeemPoints: number; grandTotal: number; lines: BillLine[]; canRedeem: boolean; now: Date }, session: ClientSession) {
  let redeem = 0;
  if (o.redeemPoints) {
    if (!c) throw AppError.validation('Points need a customer — pick one first', [{ field: 'body.customerId', message: 'Pick a customer to use points' }]);
    if (!r.enabled) throw AppError.validation('Points are off in this shop', [{ field: 'body.redeemPoints', message: 'Points are off' }]);
    if (!o.canRedeem) throw AppError.forbidden('Using points needs loyalty create permission');
    const balance = await expire(t, c, o.now, r, session);
    const cap = redeemCap(o.grandTotal, balance, r);
    if (r.redeemMultipleOf > 1 && o.redeemPoints % r.redeemMultipleOf) {
      throw AppError.validation(`Points go in multiples of ${String(r.redeemMultipleOf)}`, [{ field: 'body.redeemPoints', message: `Multiples of ${String(r.redeemMultipleOf)}` }]);
    }
    if (o.redeemPoints > cap.usable) {
      const why = balance < r.minPointsToRedeem ? `${c.name} has ${String(balance)} points — needs ${String(r.minPointsToRedeem)} to use them` : `At most ${String(cap.usable)} points on this bill (${String(r.maxRedeemPercent)}% of ${inr(o.grandTotal)}, ${c.name} has ${String(balance)})`;
      throw AppError.conflict(why, { reason: 'POINTS_CAP', usable: cap.usable, balance });
    }
    redeem = o.redeemPoints;
  }
  const redeemValue = redeem * r.pointValue;
  const linesTotal = o.lines.reduce((s, l) => s + l.totalAmount, 0);
  const eligible = o.lines.filter((l) => earnsPoints(l.category, r)).reduce((s, l) => s + l.totalAmount, 0);
  const paysOn = r.earnOnDiscountedAmount ? o.grandTotal - redeemValue : o.grandTotal;
  const base = linesTotal > 0 ? rhu(paysOn * eligible, linesTotal) : 0;
  const tierName = c ? c.tier || (tierFor(c.lifetimePointsEarned, r.tiers)?.name ?? '') : '';
  const e = c ? earn(base, tierName, r) : { amount: 0, base: 0, mult: 1, points: 0 };
  return { redeem, redeemValue, earned: e.points, earnBase: base };
}

/** In the bill's transaction: redeem first, then earn, so the new lot is the newest one. */
export async function afterBill(t: TenantContext, r: LoyaltyRules, c: Who, s: { saleId: Types.ObjectId; billNumber: string; redeem: number; earned: number; actor: Actor; at: Date }, session: ClientSession) {
  const meta = { refType: 'SALE' as const, refId: s.saleId, refNumber: s.billNumber, actor: s.actor, at: s.at };
  let out: Awaited<ReturnType<typeof post>> | null = null;
  let tierBefore: string | null = null;
  if (s.redeem) {
    out = await post(t, c, { ...meta, type: 'REDEEM', points: -s.redeem }, r, session);
    tierBefore = out.tierBefore;
  }
  if (s.earned) {
    out = await post(t, c, { ...meta, type: 'EARN', points: s.earned }, r, session);
    tierBefore ??= out.tierBefore;
  }
  if (!out) return null;
  return { balance: out.balance, tier: out.tier, tierUp: tierBefore !== null && tierBefore !== out.tier && Boolean(tierBefore) ? { from: tierBefore, to: out.tier } : null };
}

type SaleForPoints = {
  _id: Types.ObjectId;
  billNumber: string;
  customerId?: Types.ObjectId | null;
  customerName: string;
  lines: { quantityInBase: number; returnedQuantity: number; totalAmount: number; noPoints?: boolean | null }[];
  loyaltyPointsRedeemed?: number | null;
  loyaltyDiscountAmount?: number | null;
  loyaltyPointsEarned?: number | null;
  loyaltyPointsReversed?: number | null;
  loyaltyPointsRestored?: number | null;
};

/**
 * What a return moves (cumulative, like the money): earned points follow the earning lines back,
 * redeemed points follow the whole bill back — as points, never as cash, and never worth more than the refund.
 */
export function returnShares(s: SaleForPoints, taken: Map<number, number>, total: number) {
  const value = (i: number, q: number) => rhu((s.lines[i]?.totalAmount ?? 0) * q, s.lines[i]?.quantityInBase ?? 1);
  let all = 0;
  let allAfter = 0;
  let elig = 0;
  let eligAfter = 0;
  let eligBack = true;
  let everyBack = true;
  s.lines.forEach((l, i) => {
    const q = l.returnedQuantity + (taken.get(i) ?? 0);
    all += l.totalAmount;
    allAfter += value(i, q);
    if (q < l.quantityInBase) everyBack = false;
    if (l.noPoints) return;
    elig += l.totalAmount;
    eligAfter += value(i, q);
    if (q < l.quantityInBase) eligBack = false;
  });
  const earned = s.loyaltyPointsEarned ?? 0;
  const redeemed = s.loyaltyPointsRedeemed ?? 0;
  const reverse = Math.max(0, shareOf(earned, eligAfter, elig, eligBack) - (s.loyaltyPointsReversed ?? 0));
  const pv = redeemed ? Math.round((s.loyaltyDiscountAmount ?? 0) / redeemed) : 0;
  const owed = Math.max(0, shareOf(redeemed, allAfter, all, everyBack) - (s.loyaltyPointsRestored ?? 0));
  const restore = pv ? Math.min(owed, Math.floor(total / pv)) : 0;
  return { reverse, restore, restoreValue: restore * pv };
}

/** Return or cancel: take earned points back (never below zero) and give redeemed ones back. */
export async function takeBack(t: TenantContext, r: LoyaltyRules, s: SaleForPoints, m: { reverse: number; restore: number; refType: 'RETURN' | 'SALE'; refId: Types.ObjectId; refNumber: string; reason: string; actor: Actor; at: Date }, session: ClientSession) {
  if (!s.customerId || (!m.reverse && !m.restore)) return { reversed: 0, restored: 0 };
  const c = { _id: s.customerId, name: s.customerName };
  const meta = { refType: m.refType, refId: m.refId, refNumber: m.refNumber, reason: m.reason, actor: m.actor, at: m.at };
  let reversed = 0;
  if (m.reverse) {
    const balance = await expire(t, c, m.at, r, session);
    reversed = Math.min(m.reverse, balance);
    if (reversed) await post(t, c, { ...meta, type: 'REVERSAL', points: -reversed }, r, session);
  }
  if (m.restore) await post(t, c, { ...meta, type: 'REVERSAL', points: m.restore }, r, session);
  return { reversed, restored: m.restore };
}

/** Signup bonus (PLAN §16) in the customer's own transaction. */
export async function signup(t: TenantContext, c: Who, actor: Actor, session: ClientSession) {
  const r = await rules(t, session);
  if (!r.enabled || !r.signupBonusPoints) return 0;
  await post(t, c, { type: 'SIGNUP', points: r.signupBonusPoints, refType: 'SIGNUP', reason: 'Welcome bonus', actor, at: new Date() }, r, session);
  return r.signupBonusPoints;
}

/** Birthday bonus (PLAN §16) for today's IST birthdays — once a year each, from the nightly job. */
export async function birthdays(t: TenantContext, now: Date) {
  const r = await rules(t);
  if (!r.enabled || !r.birthdayBonusPoints) return 0;
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const tz = 'Asia/Kolkata';
  const people = await CustomerModel.find({
    shopId: t.shopId,
    status: 'active',
    dob: { $ne: null },
    $expr: { $and: [{ $eq: [{ $month: { date: '$dob', timezone: tz } }, ist.getUTCMonth() + 1] }, { $eq: [{ $dayOfMonth: { date: '$dob', timezone: tz } }, ist.getUTCDate()] }] },
  })
    .select('name')
    .lean();
  const yearStart = new Date(Date.UTC(ist.getUTCFullYear(), 0, 1) - 5.5 * 60 * 60 * 1000);
  let n = 0;
  for (const c of people) {
    if (await LoyaltyModel.exists({ shopId: t.shopId, customerId: c._id, type: 'BIRTHDAY', createdAt: { $gte: yearStart } })) continue;
    await inTransaction((session) => post(t, c, { type: 'BIRTHDAY', points: r.birthdayBonusPoints, refType: 'BIRTHDAY', reason: 'Happy birthday', actor: { name: 'System' }, at: now }, r, session));
    n++;
  }
  return n;
}

export async function getRules(t: TenantContext) {
  return rules(t);
}

export async function updateRules(t: TenantContext, actor: Actor, input: RulesInput, ip?: string) {
  const before = await rules(t);
  const next = { ...input, configured: true };
  await ShopModel.updateOne({ _id: t.shopId }, { $set: { 'settings.loyalty': next } });
  const what = [
    before.enabled !== next.enabled ? (next.enabled ? 'points on' : 'points off') : '',
    `1 point per ${inr(next.earnPerAmount)}`,
    `worth ${inr(next.pointValue)}`,
    `max ${String(next.maxRedeemPercent)}%`,
    next.pointExpiryMonths ? `expire after ${String(next.pointExpiryMonths)} months` : 'never expire',
  ].filter(Boolean);
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'loyalty', entityId: String(t.shopId), entityName: 'Loyalty settings', text: `${actor.name} saved loyalty settings · ${what.join(' · ')}`, ip });
  return rules(t);
}

/** Manual add / deduct (loyalty:edit, D23) with a reason; a deduct never goes below zero. */
export async function adjust(t: TenantContext, actor: Actor, input: AdjustInput, ip?: string) {
  return once(t.shopId, 'loyalty-adjust', input.clientRequestId, async (session) => {
    const now = new Date();
    const c = await CustomerModel.findOne({ shopId: t.shopId, _id: oid(input.customerId) }).select('name').session(session).lean();
    if (!c) throw AppError.notFound('Customer not found');
    const r = await rules(t, session);
    if (!r.configured) throw AppError.conflict('Points are not set up yet — set them up first');
    const balance = await expire(t, c, now, r, session);
    if (input.points < 0 && -input.points > balance) throw AppError.validation(`${c.name} has ${String(balance)} points — can’t take off ${String(-input.points)}`, [{ field: 'body.points', message: `At most ${String(balance)}` }]);
    const out = await post(t, c, { type: input.points > 0 ? 'MANUAL_ADD' : 'MANUAL_DEDUCT', points: input.points, refType: 'MANUAL', reason: input.reason, actor, at: now }, r, session);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'loyalty', entityId: String(c._id), entityName: c.name, text: `${actor.name} ${input.points > 0 ? 'added' : 'took off'} ${String(Math.abs(input.points))} points ${input.points > 0 ? 'to' : 'from'} ${c.name} · ${input.reason}`, ip }, session);
    return { customerId: String(c._id), points: input.points, balance: out.balance, tier: out.tier };
  });
}

/** Points ledger, newest first; with a customer, also the balance, tier and what expires soon. */
export async function transactions(t: TenantContext, q: LoyaltyListQuery) {
  if (q.customerId) await expireOne(t, oid(q.customerId));
  const filter: Record<string, unknown> = { shopId: t.shopId };
  if (q.customerId) filter.customerId = oid(q.customerId);
  if (q.type) filter.type = q.type;
  const sort = { field: 'createdAt', dir: -1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await LoyaltyModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const { items, meta } = page(rows, q.limit, (x) => (x as { createdAt?: Date }).createdAt ?? new Date(0));
  return {
    items: items.map((x) => ({
      id: String(x._id),
      customerId: String(x.customerId),
      customerName: x.customerName,
      type: x.type,
      points: x.points,
      balanceAfter: x.balanceAfter,
      remaining: x.remaining ?? null,
      expiresAt: x.expiresAt ?? null,
      refType: x.refType,
      refId: x.refId ? String(x.refId) : null,
      refNumber: x.refNumber,
      reason: x.reason,
      userName: x.userName,
      createdAt: (x as { createdAt?: Date }).createdAt ?? null,
    })),
    meta,
  };
}

/** A customer's points card: balance, tier, next tier and the earliest points to expire. */
export async function card(t: TenantContext, id: string) {
  await expireOne(t, oid(id));
  const c = await CustomerModel.findOne({ shopId: t.shopId, _id: oid(id) }).select('name loyaltyPoints lifetimePointsEarned lifetimePointsRedeemed tier').lean();
  if (!c) throw AppError.notFound('Customer not found');
  const r = await rules(t);
  const now = new Date();
  const soon = await LoyaltyModel.find({ shopId: t.shopId, customerId: c._id, remaining: { $gt: 0 }, expiresAt: { $gte: now, $lte: new Date(now.getTime() + r.expiryWarningDays * DAY) } }).sort({ expiresAt: 1 }).select('remaining expiresAt').lean();
  const next = nextTier(c.lifetimePointsEarned, r.tiers);
  return {
    points: c.loyaltyPoints,
    value: c.loyaltyPoints * r.pointValue,
    lifetimeEarned: c.lifetimePointsEarned,
    lifetimeRedeemed: c.lifetimePointsRedeemed,
    tier: c.tier || (tierFor(c.lifetimePointsEarned, r.tiers)?.name ?? ''),
    nextTier: next ? { name: next.name, at: next.minLifetimePoints, need: next.minLifetimePoints - c.lifetimePointsEarned } : null,
    expiring: soon.length ? { points: soon.reduce((s, l) => s + (l.remaining ?? 0), 0), from: soon[0]?.expiresAt ?? null } : null,
  };
}

/** Issued, redeemed, expired in a range; outstanding and liability now; tier mix; who has points expiring soon. */
export async function summary(t: TenantContext, from: Date, to: Date) {
  const now = new Date();
  await expireDue(t, now);
  const r = await rules(t);
  const byType = await LoyaltyModel.aggregate<{ _id: string; points: number }>([
    { $match: { shopId: t.shopId, createdAt: { $gte: from, $lte: new Date(to.getTime() + DAY - 1) } } },
    { $group: { _id: '$type', points: { $sum: '$points' } } },
  ]);
  const sum = (...types: LoyaltyType[]) => byType.filter((x) => types.includes(x._id as LoyaltyType)).reduce((s, x) => s + x.points, 0);
  const [out] = await CustomerModel.aggregate<{ points: number; holders: number }>([{ $match: { shopId: t.shopId, loyaltyPoints: { $gt: 0 } } }, { $group: { _id: null, points: { $sum: '$loyaltyPoints' }, holders: { $sum: 1 } } }]);
  const tiers = await CustomerModel.aggregate<{ _id: string; n: number }>([{ $match: { shopId: t.shopId, tier: { $ne: '' } } }, { $group: { _id: '$tier', n: { $sum: 1 } } }]);
  const soon = await LoyaltyModel.aggregate<{ _id: Types.ObjectId; name: string; points: number; from: Date }>([
    { $match: { shopId: t.shopId, remaining: { $gt: 0 }, expiresAt: { $gte: now, $lte: new Date(now.getTime() + r.expiryWarningDays * DAY) } } },
    { $group: { _id: '$customerId', name: { $first: '$customerName' }, points: { $sum: '$remaining' }, from: { $min: '$expiresAt' } } },
    { $sort: { from: 1 } },
    { $limit: 20 },
  ]);
  const outstanding = out?.points ?? 0;
  return {
    issued: sum('EARN', 'SIGNUP', 'BIRTHDAY'),
    redeemed: -sum('REDEEM'),
    expired: -sum('EXPIRE'),
    manual: sum('MANUAL_ADD', 'MANUAL_DEDUCT'),
    reversed: sum('REVERSAL'),
    outstanding,
    holders: out?.holders ?? 0,
    liability: outstanding * r.pointValue,
    tiers: r.tiers.map((x) => ({ name: x.name, customers: tiers.find((y) => y._id === x.name)?.n ?? 0 })),
    expiring: soon.map((x) => ({ customerId: String(x._id), name: x.name, points: x.points, from: x.from })),
    expiringPoints: soon.reduce((s, x) => s + x.points, 0),
  };
}
