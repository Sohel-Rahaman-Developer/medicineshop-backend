import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { AskQuestionModel } from '../ask/ask.model';
import { priceOf, type AiSettings, type Price } from './ai-settings';
import { AiReadModel, CoinEntryModel, CoinOrderModel, CoinWalletModel, type AiModelId } from './ai.model';

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

/** The least a coin brings in: the cheapest pack's price per coin, 18% GST taken out. */
export const coinValue = (s: Pick<AiSettings, 'packs'>) => Math.min(...s.packs.map((k) => Math.floor(k.price / GST / Math.max(1, k.coins))));

/** Worst cost of one bill page and of one chat question, in paise — input at the dearer of input and cache-write. */
export const worstPage = (s: AiSettings, model: AiModelId = s.model) => paise(PAGE_IN, PAGE_OUT, priceOf(s, model), s.usdInr);
export const worstQuestion = (s: AiSettings, chat: Pick<AiSettings['chat'], 'model' | 'capIn' | 'capOut'> = s.chat) => paise(chat.capIn, chat.capOut, priceOf(s, chat.model), s.usdInr);

export interface Check {
  feature: 'read' | 'chat';
  on: boolean;
  worstPaise: number;
  chargePaise: number;
  safe: boolean;
}

/** Both features against the coins they charge, whether on or not. */
export function checks(s: AiSettings): Check[] {
  const coin = coinValue(s);
  const read = { feature: 'read' as const, on: s.enabled, worstPaise: worstPage(s), chargePaise: s.coinsPerPage * coin };
  const chat = { feature: 'chat' as const, on: s.chat.enabled, worstPaise: worstQuestion(s), chargePaise: s.chat.coinsPerQuestion * coin };
  return [read, chat].map((c) => ({ ...c, safe: c.chargePaise >= c.worstPaise }));
}

const rs = (p: number) => `₹${(p / 100).toFixed(2)}`;
const WHAT = { read: 'A bill page', chat: 'A chat question' } as const;
const FIX = { read: 'charge more tokens a page or pick a cheaper model', chat: 'charge more tokens a question, lower the caps or pick a cheaper model' } as const;

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
 * What a shop may still cost: coins bought (GST out) plus coins MedBox24 gave and free questions used, both at a
 * coin's value, less every AI cost so far — failed and refunded work included, and running work at its worst case.
 */
export async function roomOf(shopId: Types.ObjectId, s: AiSettings): Promise<Room> {
  const coin = coinValue(s);
  const [paid, gifts, wallet, reads, asks] = await Promise.all([
    CoinOrderModel.aggregate<{ net: number }>([{ $match: { shopId, status: 'paid' } }, { $group: { _id: null, net: { $sum: { $subtract: ['$amount', '$gst'] } } } }]),
    CoinEntryModel.aggregate<{ coins: number }>([{ $match: { shopId, kind: { $in: ['grant', 'welcome'] } } }, { $group: { _id: null, coins: { $sum: '$coins' } } }]),
    CoinWalletModel.findOne({ shopId }).select('askFree').lean(),
    AiReadModel.aggregate<{ cost: number; runningPages: number }>([{ $match: { shopId } }, { $group: { _id: null, cost: { $sum: '$costPaise' }, runningPages: { $sum: { $cond: [{ $eq: ['$status', 'running'] }, '$pages', 0] } } } }]),
    AskQuestionModel.aggregate<{ cost: number; running: number }>([{ $match: { shopId, route: { $in: ['ai', 'off_topic'] } } }, { $group: { _id: null, cost: { $sum: '$costPaise' }, running: { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } } } }]),
  ]);
  const paidPaise = paid[0]?.net ?? 0;
  const giftedPaise = Math.max(0, gifts[0]?.coins ?? 0) * coin + (wallet?.askFree ?? 0) * s.chat.coinsPerQuestion * coin;
  const burnedPaise = (reads[0]?.cost ?? 0) + (reads[0]?.runningPages ?? 0) * worstPage(s) + (asks[0]?.cost ?? 0) + (asks[0]?.running ?? 0) * worstQuestion(s);
  const allowancePaise = paidPaise + giftedPaise;
  return { paidPaise, giftedPaise, allowancePaise, burnedPaise, leftPaise: allowancePaise - burnedPaise };
}

/** True when this job's worst case still fits in what the shop has paid for (or was given). */
export async function fits(shopId: Types.ObjectId, s: AiSettings, worstPaise: number) {
  return (await roomOf(shopId, s)).leftPaise >= worstPaise;
}

export const AI_PAUSED = 'AI_PAUSED';
