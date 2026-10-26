import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { audit } from '../audit/audit.model';
import { CustomerModel } from '../customers/customer.model';
import { SaleModel } from '../sales/sale.model';
import { ShopModel } from '../shops/shop.model';
import { logoPathOf, publicCodeOf } from '../shops/shop-logo';
import { featuresOf } from '../subscription/plan-access';
import { SubscriptionModel } from '../subscription/subscription.model';
import type { Actor } from '../user/actor';
import { nextTier, tierFor, type LoyaltyRules } from './loyalty.domain';
import { LoyaltyModel, type LoyaltyType } from './loyalty.model';
import { rules, rulesOf } from './loyalty.service';

const DAY = 24 * 60 * 60 * 1000;
const newToken = () => randomBytes(18).toString('base64url');
export const TOKEN = /^[A-Za-z0-9_-]{24}$/;

const linkOf = (token: string) => `${env.SHOP_APP_URL}/p/${token}`;
const counterOf = (code: string) => `${env.SHOP_APP_URL}/l/${code}`;

/** D92: the customer's own points link, for the bill's WhatsApp message; made once, the first time it is asked for. Points off → no link. */
export async function pointsLink(t: TenantContext, id: string): Promise<{ url: string | null }> {
  const _id = new Types.ObjectId(id);
  const c = await CustomerModel.findOne({ shopId: t.shopId, _id }).select('pointsToken').lean();
  if (!c) throw AppError.notFound('Customer not found');
  if (!(await rules(t)).enabled) return { url: null };
  if (c.pointsToken) return { url: linkOf(c.pointsToken) };
  await CustomerModel.updateOne({ shopId: t.shopId, _id, pointsToken: { $exists: false } }, { $set: { pointsToken: newToken() } });
  const now = await CustomerModel.findOne({ shopId: t.shopId, _id }).select('pointsToken').lean();
  return { url: linkOf(now?.pointsToken ?? '') };
}

/** A link sent to the wrong number: a new one, and the old one stops working. */
export async function renewPointsLink(t: TenantContext, actor: Actor, id: string, ip?: string) {
  const _id = new Types.ObjectId(id);
  const c = await CustomerModel.findOneAndUpdate({ shopId: t.shopId, _id }, { $set: { pointsToken: newToken() } }, { returnDocument: 'after' }).select('name pointsToken').lean();
  if (!c) throw AppError.notFound('Customer not found');
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'customers', entityId: id, entityName: c.name, text: `Made a new points link for ${c.name} — the old one no longer opens`, ip });
  return { url: linkOf(c.pointsToken ?? '') };
}

/** The counter QR's address, printed on the card. */
export async function counterLink(t: TenantContext) {
  const code = await publicCodeOf(t.shopId);
  return { url: counterOf(code), code };
}

/** Loyalty as the public sees it: only when the shop turned it on and its plan has it. */
async function liveRules(shopId: Types.ObjectId, raw: unknown): Promise<LoyaltyRules | null> {
  const sub = await SubscriptionModel.findOne({ shopId }).select('planCode').lean();
  const r = rulesOf(raw);
  return r.enabled && sub && (await featuresOf(sub.planCode)).includes('loyalty') ? r : null;
}

async function shopFace(s: { _id: Types.ObjectId; name: string; address?: { city?: string | null } | null; phone?: string | null }) {
  return { name: s.name, city: s.address?.city ?? '', phone: s.phone ?? '', logo: await logoPathOf(s._id) };
}

const plainRules = (r: LoyaltyRules) => ({
  earnRate: r.earnRate,
  earnPerAmount: r.earnPerAmount,
  minBillForEarning: r.minBillForEarning,
  pointValue: r.pointValue,
  minPointsToRedeem: r.minPointsToRedeem,
  maxRedeemPercent: r.maxRedeemPercent,
  pointExpiryMonths: r.pointExpiryMonths,
  tiers: r.tiers.map((x) => ({ name: x.name, minLifetimePoints: x.minLifetimePoints, earnMultiplier: x.earnMultiplier })),
  birthdayBonusPoints: r.birthdayBonusPoints,
});

/** The shop's QR page: who they are and how points work — never anything about a customer. */
export async function publicShop(code: string) {
  const s = await ShopModel.findOne({ publicCode: code, status: 'active' }).select('name address.city phone settings.loyalty').lean();
  if (!s) throw AppError.notFound('This page isn’t here');
  const r = await liveRules(s._id, s.settings.loyalty);
  return { shop: await shopFace(s), loyalty: r ? plainRules(r) : null };
}

const LABEL: Record<LoyaltyType, string> = {
  EARN: 'Earned',
  REDEEM: 'Used',
  REVERSAL: 'Bill returned',
  MANUAL_ADD: 'Added by the shop',
  MANUAL_DEDUCT: 'Taken off by the shop',
  EXPIRE: 'Expired',
  SIGNUP: 'Welcome points',
  BIRTHDAY: 'Birthday bonus',
};

/** How far back the customer's own page shows bills and points. */
export const SHOW_YEARS = 2;
const EARNED: LoyaltyType[] = ['EARN', 'MANUAL_ADD', 'SIGNUP', 'BIRTHDAY'];

type BillLine = { item: number; productName: string; quantityInBase: number; unit: string; baseUnit: string; salePack: number; returnedQuantity: number };

/** A bill's medicines, one per cart line (batches joined): "2 strip", "1 strip + 5 tablet". */
function itemsOf(lines: BillLine[]) {
  const byItem = new Map<number, { name: string; base: number; back: number; unit: string; baseUnit: string; pack: number }>();
  for (const l of lines) {
    const x = byItem.get(l.item) ?? { name: l.productName, base: 0, back: 0, unit: l.unit, baseUnit: l.baseUnit, pack: Math.max(1, l.salePack) };
    x.base += l.quantityInBase;
    x.back += l.returnedQuantity;
    byItem.set(l.item, x);
  }
  return [...byItem.values()].map((x) => {
    const packs = Math.floor(x.base / x.pack);
    const loose = x.base % x.pack;
    const qty = [packs ? `${String(packs)} ${x.unit.toLowerCase()}` : '', loose ? `${String(loose)} ${x.baseUnit.toLowerCase()}` : ''].filter(Boolean).join(' + ');
    return { name: x.name, qty, returned: x.back >= x.base ? 'all' : x.back > 0 ? 'some' : null };
  });
}

/** The page behind a customer's secret link: their points, bills and history — first name only, no phone. */
export async function publicPoints(token: string) {
  const c = await CustomerModel.findOne({ pointsToken: token, status: 'active' })
    .setOptions({ crossTenant: true })
    .select('shopId name loyaltyPoints lifetimePointsEarned tier')
    .lean();
  if (!c) throw AppError.notFound('This link doesn’t open any more — ask the shop for a new one');
  const s = await ShopModel.findOne({ _id: c.shopId, status: 'active' }).select('name address.city phone settings.loyalty').lean();
  if (!s) throw AppError.notFound('This link doesn’t open any more — ask the shop for a new one');
  const r = await liveRules(s._id, s.settings.loyalty);
  const now = new Date();
  const since = new Date(now);
  since.setFullYear(since.getFullYear() - SHOW_YEARS);
  const [history, bills, sums, soon] = await Promise.all([
    LoyaltyModel.find({ shopId: c.shopId, customerId: c._id, createdAt: { $gte: since } }).sort({ createdAt: -1, _id: -1 }).limit(50).select('type points balanceAfter refNumber createdAt').lean(),
    SaleModel.find({ shopId: c.shopId, customerId: c._id, status: { $ne: 'cancelled' }, billDate: { $gte: since } })
      .sort({ billDate: -1, _id: -1 })
      .limit(300)
      .select('billNumber billDate grandTotal status loyaltyPointsEarned loyaltyPointsRedeemed lines.item lines.productName lines.quantityInBase lines.unit lines.baseUnit lines.salePack lines.returnedQuantity')
      .lean(),
    LoyaltyModel.aggregate<{ _id: LoyaltyType; points: number }>([{ $match: { shopId: c.shopId, customerId: c._id, createdAt: { $gte: since } } }, { $group: { _id: '$type', points: { $sum: '$points' } } }]),
    r ? LoyaltyModel.find({ shopId: c.shopId, customerId: c._id, remaining: { $gt: 0 }, expiresAt: { $gte: now, $lte: new Date(now.getTime() + r.expiryWarningDays * DAY) } }).sort({ expiresAt: 1 }).select('remaining expiresAt').lean() : Promise.resolve([]),
  ]);
  const sum = (types: LoyaltyType[]) => Math.abs(sums.filter((x) => types.includes(x._id)).reduce((t, x) => t + x.points, 0));
  const last = bills[0];
  const next = r ? nextTier(c.lifetimePointsEarned, r.tiers) : null;
  return {
    shop: await shopFace(s),
    on: Boolean(r),
    name: c.name.trim().split(/\s+/)[0] ?? '',
    points: c.loyaltyPoints,
    value: r ? c.loyaltyPoints * r.pointValue : 0,
    tier: c.tier || (r ? (tierFor(c.lifetimePointsEarned, r.tiers)?.name ?? '') : ''),
    nextTier: next ? { name: next.name, need: next.minLifetimePoints - c.lifetimePointsEarned } : null,
    expiring: soon.length ? { points: soon.reduce((n, l) => n + (l.remaining ?? 0), 0), from: soon[0]?.expiresAt ?? null } : null,
    lastBill: last ? { number: last.billNumber, date: last.billDate, total: last.grandTotal, earned: last.loyaltyPointsEarned, used: last.loyaltyPointsRedeemed } : null,
    years: SHOW_YEARS,
    since,
    totals: { earned: sum(EARNED), used: sum(['REDEEM']), expired: sum(['EXPIRE']), takenBack: sum(['REVERSAL', 'MANUAL_DEDUCT']), spent: bills.reduce((t, b) => t + b.grandTotal, 0), bills: bills.length },
    bills: bills.map((b) => ({ number: b.billNumber, date: b.billDate, total: b.grandTotal, earned: b.loyaltyPointsEarned ?? 0, used: b.loyaltyPointsRedeemed ?? 0, returned: b.status === 'returned' ? 'all' : b.status === 'partially_returned' ? 'some' : null, items: itemsOf(b.lines) })),
    history: history.map((h) => ({ type: h.type, label: LABEL[h.type], points: h.points, balanceAfter: h.balanceAfter, bill: h.refNumber || null, at: (h as { createdAt?: Date }).createdAt ?? null })),
    rules: r ? plainRules(r) : null,
  };
}
