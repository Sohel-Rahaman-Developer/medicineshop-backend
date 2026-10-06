import { randomInt } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { ShopModel } from '../shops/shop.model';
import { SubscriptionPaymentModel } from '../subscription/billing.model';
import { ReferralModel, ReferralSettingsModel } from './referral.model';

const DAY = 24 * 60 * 60 * 1000;
/** "3 months in a row" = 90 paid days without a break; a yearly plan (365) clears it at once. */
const MONTH_DAYS = 30;

export const referralSettingsSchema = z
  .object({
    enabled: z.boolean(),
    newShopPct: z.number().int().min(0).max(50),
    newShopDays: z.number().int().min(1).max(365),
    rewardPct: z.number().int().min(0).max(50),
    qualifyMonths: z.number().int().min(1).max(12),
  })
  .strict();
export type ReferralSettings = z.infer<typeof referralSettingsSchema>;

export async function referralSettings(): Promise<ReferralSettings> {
  const s = await ReferralSettingsModel.findById('referral').lean();
  return { enabled: s?.enabled ?? true, newShopPct: s?.newShopPct ?? 10, newShopDays: s?.newShopDays ?? 30, rewardPct: s?.rewardPct ?? 10, qualifyMonths: s?.qualifyMonths ?? 3 };
}

export async function saveReferralSettings(input: ReferralSettings, by: string) {
  await ReferralSettingsModel.updateOne({ _id: 'referral' }, { $set: { ...input, updatedBy: by } }, { upsert: true });
  return referralSettings();
}

const DIGITS = '23456789';
export const normCode = (c: string) => c.trim().toUpperCase().replace(/[\s-]/g, '');
const codeError = (message: string) => AppError.validation(message, [{ field: 'body.referralCode', message }]);

/** The shop's own code — up to 5 letters of its name and 3 digits (SHRIR482) — made once, on first ask. */
export async function codeOf(shopId: Types.ObjectId): Promise<string> {
  const s = await ShopModel.findById(shopId).select('name referralCode').lean();
  if (!s) throw AppError.notFound('Shop not found');
  if (s.referralCode) return s.referralCode;
  const stem = `${s.name.toUpperCase().replace(/[^A-Z]/g, '')}MEDSHOP`.slice(0, 5);
  for (let i = 0; i < 8; i++) {
    const code = stem + Array.from({ length: i < 4 ? 3 : 5 }, () => DIGITS[randomInt(DIGITS.length)]).join('');
    try {
      if ((await ShopModel.updateOne({ _id: shopId, referralCode: { $exists: false } }, { $set: { referralCode: code } })).modifiedCount === 1) return code;
      const won = await ShopModel.findById(shopId).select('referralCode').lean();
      if (won?.referralCode) return won.referralCode;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  throw AppError.internal();
}

async function referrerBy(code: string, userId: Types.ObjectId, session?: ClientSession) {
  const c = normCode(code);
  const shop = c ? await ShopModel.findOne({ referralCode: c }).select('name ownerUserId').session(session ?? null).lean() : null;
  if (!shop) throw codeError('No shop has this referral code — check it, or leave the box empty');
  if (shop.ownerUserId.equals(userId)) throw codeError('This is your own shop’s code — it works only for another owner');
  return shop;
}

/** Onboarding: whose code is it, and what the new shop gets. */
export async function checkCode(userId: string, code: string) {
  const st = await referralSettings();
  if (!st.enabled) throw codeError('Referral codes are not taken right now');
  const shop = await referrerBy(code, new Types.ObjectId(userId));
  return { code: normCode(code), shopName: shop.name, newShopPct: st.newShopPct, newShopDays: st.newShopDays };
}

/** Inside the new shop's transaction: a bad code stops the shop from being made, so the owner can fix it. */
export async function linkAtSignup(shopId: Types.ObjectId, userId: Types.ObjectId, code: string, by: string, now: Date, session: ClientSession) {
  const st = await referralSettings();
  if (!st.enabled) throw codeError('Referral codes are not taken right now — leave the box empty');
  const ref = await referrerBy(code, userId, session);
  await ReferralModel.create([{ referrerShopId: ref._id, refereeShopId: shopId, source: 'signup', code: normCode(code), newShopPct: st.newShopPct, newShopUntil: new Date(now.getTime() + st.newShopDays * DAY), rewardPct: st.rewardPct, qualifyDays: st.qualifyMonths * MONTH_DAYS, setBy: by }], { session });
}

export interface Offer { kind: 'welcome' | 'reward'; pct: number; referralId: Types.ObjectId; until: Date | null }

/** One discount per payment: the new shop's welcome on its first payment, else the oldest reward waiting. */
export async function discountFor(shopId: Types.ObjectId, now = new Date()): Promise<Offer | null> {
  const mine = await ReferralModel.findOne({ refereeShopId: shopId }).lean();
  if (mine && !mine.welcomePaymentId && mine.newShopPct > 0 && now < mine.newShopUntil && !(await SubscriptionPaymentModel.exists({ shopId, status: 'paid' }))) return { kind: 'welcome', pct: mine.newShopPct, referralId: mine._id, until: mine.newShopUntil };
  const r = await ReferralModel.findOne({ referrerShopId: shopId, reward: 'ready' }).sort({ qualifiedAt: 1, _id: 1 }).lean();
  return r && r.rewardPct > 0 ? { kind: 'reward', pct: r.rewardPct, referralId: r._id, until: null } : null;
}

/** Whole rupees off, so the bill reads cleanly. */
export function withOffer(price: number, o: Offer | null) {
  const off = o ? Math.round((price * o.pct) / 10_000) * 100 : 0;
  return { amount: price - off, off };
}

/** The referee's streak: paid days in a row, reset by a lapse or a full refund. Qualifies once, then stays. */
export async function evaluate(shopId: Types.ObjectId, now: Date, session?: ClientSession) {
  const r = await ReferralModel.findOne({ refereeShopId: shopId }).session(session ?? null);
  if (!r || r.status === 'qualified') return;
  const paid = await SubscriptionPaymentModel.find({ shopId, status: 'paid' }).sort({ paidAt: 1, _id: 1 }).select('durationDays continued amount refunded').session(session ?? null).lean();
  let streak = 0;
  for (const p of paid) streak = p.refunded >= p.amount ? 0 : (p.continued ? streak : 0) + p.durationDays;
  r.set({ streakDays: streak, ...(streak >= r.qualifyDays ? { status: 'qualified', qualifiedAt: now, reward: r.rewardPct > 0 ? 'ready' : 'none' } : {}) });
  await r.save({ session });
}

/** markPaid's transaction: spend the discount it carried, then move the streak on. */
export async function afterPaid(pay: { _id: Types.ObjectId; shopId: Types.ObjectId; discount?: { kind: string; referralId: Types.ObjectId } | null }, now: Date, session: ClientSession) {
  const d = pay.discount;
  if (d?.kind === 'welcome') await ReferralModel.updateOne({ _id: d.referralId, welcomePaymentId: { $exists: false } }, { $set: { welcomePaymentId: pay._id } }, { session });
  if (d?.kind === 'reward') await ReferralModel.updateOne({ _id: d.referralId, reward: 'ready' }, { $set: { reward: 'used', rewardPaymentId: pay._id, rewardUsedAt: now } }, { session });
  await evaluate(pay.shopId, now, session);
}

const names = async (ids: Types.ObjectId[]) => ShopModel.find({ _id: { $in: ids } }).select('name').lean();
interface Row { _id: Types.ObjectId; referrerShopId: Types.ObjectId; refereeShopId: Types.ObjectId; source: string; status: string; streakDays: number; qualifyDays: number; reward: string; rewardPct: number; newShopPct: number; newShopUntil: Date; welcomePaymentId?: Types.ObjectId | null; qualifiedAt?: Date | null; rewardUsedAt?: Date | null; setBy: string; createdAt?: Date }
const shape = (r: Row, list: { _id: Types.ObjectId; name: string }[]) => ({
  id: String(r._id),
  referrer: { id: String(r.referrerShopId), name: list.find((s) => s._id.equals(r.referrerShopId))?.name ?? '' },
  referee: { id: String(r.refereeShopId), name: list.find((s) => s._id.equals(r.refereeShopId))?.name ?? '' },
  source: r.source, status: r.status, streakDays: r.streakDays, qualifyDays: r.qualifyDays, reward: r.reward, rewardPct: r.rewardPct,
  welcome: { pct: r.newShopPct, until: r.newShopUntil, used: Boolean(r.welcomePaymentId) },
  qualifiedAt: r.qualifiedAt ?? null, rewardUsedAt: r.rewardUsedAt ?? null, setBy: r.setBy, at: r.createdAt ?? null,
});

/** Both sides of one shop: who brought it, and whom it brought. */
export async function referralsOf(shopId: Types.ObjectId) {
  const [mine, given] = await Promise.all([ReferralModel.findOne({ refereeShopId: shopId }).lean<Row>(), ReferralModel.find({ referrerShopId: shopId }).sort({ createdAt: -1 }).limit(200).lean<Row[]>()]);
  const list = await names([...(mine ? [mine.referrerShopId, mine.refereeShopId] : []), ...given.map((g) => g.refereeShopId), shopId]);
  return { referredBy: mine ? shape(mine, list) : null, referred: given.map((g) => shape(g, list)) };
}

/** The owner's Refer a shop card. */
export async function forShop(shopId: Types.ObjectId, now = new Date()) {
  const [st, code, offer, both] = await Promise.all([referralSettings(), codeOf(shopId), discountFor(shopId, now), referralsOf(shopId)]);
  return { ...st, code, offer: offer ? { kind: offer.kind, pct: offer.pct, until: offer.until } : null, ...both, rewardsReady: both.referred.filter((r) => r.reward === 'ready').length };
}

/** Admin: every referral, newest first (the last 200). */
export async function allReferrals() {
  const rows = await ReferralModel.find({}).sort({ createdAt: -1 }).limit(200).lean<Row[]>();
  const list = await names([...new Set(rows.flatMap((r) => [String(r.referrerShopId), String(r.refereeShopId)]))].map((id) => new Types.ObjectId(id)));
  return rows.map((r) => shape(r, list));
}

/**
 * Admin, when an owner forgot the code: set, change or remove who referred a shop. Once it has earned the reward
 * it is settled and can't move. The terms are today's settings; the welcome window still counts from the shop's start.
 */
export async function assignReferrer(shopId: Types.ObjectId, referrerId: Types.ObjectId | null, by: string, now = new Date()) {
  const shop = await ShopModel.findById(shopId).select('name createdAt').lean<{ _id: Types.ObjectId; name: string; createdAt: Date }>();
  if (!shop) throw AppError.notFound('Shop not found');
  const existing = await ReferralModel.findOne({ refereeShopId: shopId });
  if (existing?.status === 'qualified') throw AppError.conflict('This referral has already earned its reward — it can’t be changed');
  const before = existing ? ((await ShopModel.findById(existing.referrerShopId).select('name').lean())?.name ?? '') : null;
  if (!referrerId) {
    if (!existing) throw AppError.conflict('No one is set as the referrer');
    await existing.deleteOne();
    return { shop: shop.name, before, after: null };
  }
  const field = (message: string) => AppError.validation(message, [{ field: 'body.referrerShopId', message }]);
  if (referrerId.equals(shopId)) throw field('A shop can’t refer itself');
  const ref = await ShopModel.findById(referrerId).select('name').lean();
  if (!ref) throw field('Shop not found');
  if (await ReferralModel.exists({ refereeShopId: referrerId, referrerShopId: shopId })) throw field(`${ref.name} was referred by this shop — it can’t be the other way round too`);
  if (existing?.referrerShopId.equals(referrerId)) throw AppError.conflict(`${ref.name} is already the referrer`);
  const code = await codeOf(referrerId);
  if (existing) {
    existing.set({ referrerShopId: referrerId, code, source: 'admin', setBy: by });
    await existing.save();
  } else {
    const st = await referralSettings();
    await ReferralModel.create({ referrerShopId: referrerId, refereeShopId: shopId, source: 'admin', code, newShopPct: st.newShopPct, newShopUntil: new Date(shop.createdAt.getTime() + st.newShopDays * DAY), rewardPct: st.rewardPct, qualifyDays: st.qualifyMonths * MONTH_DAYS, setBy: by });
  }
  // Payments made before the referrer was set still count towards the streak.
  await evaluate(shopId, now);
  return { shop: shop.name, before, after: ref.name };
}
