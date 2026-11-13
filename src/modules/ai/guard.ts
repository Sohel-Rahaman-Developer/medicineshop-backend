import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { AskQuestionModel } from '../ask/ask.model';
import { priceOf, type AiSettings, type Price } from './ai-settings';
import { AiReadModel, CoinEntryModel, CoinOrderModel, CoinWalletModel, PACK_NET, type AiModelId } from './ai.model';

// D97: AI never costs MedBox24 more than the coins bring in. Every read and question has a worst case fixed before it
// starts (its token caps); a price that could lose money can't be saved and can't run; and each shop's total AI cost
// stays under what it paid for coins plus what MedBox24 chose to give it.

const GST = 1.18;
/** A bill page may send at most this much and get this much back (thinking included); the read's caps follow from it. */
export const PAGE_IN = 4000;
export const PAGE_OUT = 8000;
/** Gemini answers at most 65,536 tokens; Claude more — one ceiling for both. */
export const MAX_OUT = 64_000;

const paise = (tokensIn: number, tokensOut: number, p: Price, usdInr: number) => Math.ceil(((tokensIn * Math.max(p.input, p.cacheWrite) + tokensOut * p.output) * usdInr * 100) / 1_000_000);

/** What a pack's token brings in, 18% GST out, rounded down — to the paisa, or to 0.01 paise under one (₹0.01 → 0.84). */
export const perToken = (k: { price: number; coins: number }) => {
  const v = k.price / GST / Math.max(1, k.coins);
  return v >= 1 ? Math.floor(v) : Math.floor(v * 100) / 100;
};
/** The least a token brings in: the cheapest pack's. */
export const coinValue = (s: Pick<AiSettings, 'packs'>) => Math.min(...s.packs.map(perToken));

/** Worst cost of one bill page and of one chat question, in paise — input at the dearer of input and cache-write. */
export const worstPage = (s: AiSettings, model: AiModelId = s.model) => paise(PAGE_IN, PAGE_OUT, priceOf(s, model), s.usdInr);
/** D110: one medicine name in, its salt and strength out — a short job on the chat's model. */
export const SALT_IN = 600;
export const SALT_OUT = 1024;
export const worstSalt = (s: AiSettings) => paise(SALT_IN, SALT_OUT, priceOf(s, s.chat.model), s.usdInr);
export const worstQuestion = (s: AiSettings, chat: Pick<AiSettings['chat'], 'model' | 'capIn' | 'capOut'> = s.chat) => paise(chat.capIn, chat.capOut, priceOf(s, chat.model), s.usdInr);

/** D109: tokens for a real AI cost — cost × margin ÷ a token's value (GST out), rounded up; at least 1 for any cost. */
export const tokensFor = (s: Pick<AiSettings, 'targetMargin' | 'packs'>, costPaise: number) => (costPaise <= 0 ? 0 : Math.max(1, Math.ceil((costPaise * s.targetMargin) / coinValue(s))));

export interface Check {
  feature: 'read' | 'chat';
  on: boolean;
  worstPaise: number;
  /** The most tokens one job can take (its worst case) and what they bring in. */
  coins: number;
  chargePaise: number;
  safe: boolean;
}

/** Both features: their worst case against the tokens it would take (D109: the cost × margin, so never below it). */
export function checks(s: AiSettings): [Check, Check] {
  const coin = coinValue(s);
  const one = (feature: Check['feature'], on: boolean, worstPaise: number) => {
    const coins = tokensFor(s, worstPaise);
    const chargePaise = Math.floor(coins * coin);
    return { feature, on, worstPaise, coins, chargePaise, safe: chargePaise >= worstPaise };
  };
  return [one('read', s.enabled, worstPage(s)), one('chat', s.chat.enabled, worstQuestion(s))];
}

const rs = (p: number) => `₹${(p / 100).toFixed(2)}`;
const WHAT = { read: 'A bill page', chat: 'A chat question' } as const;
const FIX = { read: 'raise the margin or pick a cheaper model', chat: 'raise the margin, lower the caps or pick a cheaper model' } as const;

/** Refuses settings, prices or packs under which a feature that is on could cost more than it brings in. */
export function assertNoLoss(s: AiSettings, field: string) {
  const bad = checks(s).filter((c) => c.on && !c.safe);
  if (!bad.length) return;
  const text = bad.map((c) => `${WHAT[c.feature]} can cost up to ${rs(c.worstPaise)} but its tokens bring in ${rs(c.chargePaise)} — ${FIX[c.feature]}`).join('; ');
  throw AppError.validation(`That would lose money. ${text}.`, [{ field, message: text }]);
}

/** A feature runs only while its price is safe; a price that turned unsafe (an older setting) pauses it. */
export const safeNow = (s: AiSettings, feature: Check['feature']) => checks(s).find((c) => c.feature === feature)?.safe ?? false;

export interface Room {
  paidPaise: number;
  giftedPaise: number;
  allowancePaise: number;
  burnedPaise: number;
  leftPaise: number;
}

/**
 * What a shop may still cost: tokens bought (GST out), tokens MedBox24 gave (at a token's value — older gifts at the
 * old token's, less free tokens taken back by D109) and the free AI it used, less every AI cost so far — failed work
 * included, and running work at its worst case.
 */
export async function roomOf(shopId: Types.ObjectId, s: AiSettings): Promise<Room> {
  const coin = coinValue(s);
  const ten = s.tenCoinPaise ?? coin;
  const old = s.oldCoinPaise ?? ten;
  const since = s.tokensAt ?? new Date(8.64e15);
  const paiseAt = s.paiseAt ?? new Date(8.64e15);
  const [paid, gifts, wallet, reads, asks] = await Promise.all([
    CoinOrderModel.aggregate<{ net: number }>([{ $match: { shopId, status: 'paid' } }, { $group: { _id: null, net: { $sum: PACK_NET } } }]),
    // Gifts at the token of their day: before ₹0.10 tokens, ₹0.10 tokens, ₹0.01 tokens.
    CoinEntryModel.aggregate<{ _id: 'old' | 'ten' | 'now'; coins: number }>([{ $match: { shopId, kind: { $in: ['grant', 'welcome'] } } }, { $group: { _id: { $cond: [{ $lt: ['$createdAt', since] }, 'old', { $cond: [{ $lt: ['$createdAt', paiseAt] }, 'ten', 'now'] }] }, coins: { $sum: '$coins' } } }]),
    CoinWalletModel.findOne({ shopId }).select('askFree freeTotalPaise oldFreeGone').lean(),
    AiReadModel.aggregate<{ cost: number; runningPages: number }>([{ $match: { shopId } }, { $group: { _id: null, cost: { $sum: '$costPaise' }, runningPages: { $sum: { $cond: [{ $eq: ['$status', 'running'] }, '$pages', 0] } } } }]),
    AskQuestionModel.aggregate<{ cost: number; running: number }>([{ $match: { shopId, route: { $in: ['ai', 'off_topic'] } } }, { $group: { _id: null, cost: { $sum: '$costPaise' }, running: { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } } } }]),
  ]);
  const paidPaise = paid[0]?.net ?? 0;
  const of = (era: 'old' | 'ten' | 'now') => gifts.find((g) => g._id === era)?.coins ?? 0;
  const before = Math.max(0, of('old') - (wallet?.oldFreeGone ?? 0));
  const giftedPaise = Math.floor(Math.max(0, of('now')) * coin + Math.max(0, of('ten')) * ten + (before + (wallet?.askFree ?? 0)) * old) + (wallet?.freeTotalPaise ?? 0);
  const burnedPaise = (reads[0]?.cost ?? 0) + (reads[0]?.runningPages ?? 0) * worstPage(s) + (asks[0]?.cost ?? 0) + (asks[0]?.running ?? 0) * worstQuestion(s);
  const allowancePaise = paidPaise + giftedPaise;
  return { paidPaise, giftedPaise, allowancePaise, burnedPaise, leftPaise: allowancePaise - burnedPaise };
}

/** True when this job's worst case still fits in what the shop has paid for, was given, or has free this month. */
export async function fits(shopId: Types.ObjectId, s: AiSettings, worstPaise: number, freeLeftPaise: number) {
  return (await roomOf(shopId, s)).leftPaise + freeLeftPaise >= worstPaise;
}

export const AI_PAUSED = 'AI_PAUSED';
