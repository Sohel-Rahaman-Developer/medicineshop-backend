import type { ClientSession, Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { part } from '../../core/lang';
import { inTransaction } from '../../core/transaction';
import { logger } from '../../config/logger';
import { istMonth } from '../../utils/date';
import { aiSettings, readyFor, type AiSettings } from './ai-settings';
import { AiReadModel, AiSettingsModel, CoinEntryModel, CoinWalletModel, TOKEN_PRICE_PAISE, type CoinKind } from './ai.model';
import { checks, coinValue, tokensFor } from './guard';

// D109: AI is paid by what it really used — its cost × the margin, at what a token brings in (GST out), rounded up.
// Before a job runs its worst case is set aside (this month's free AI first, then tokens), so a job never runs on
// tokens the shop doesn't have; afterwards the real cost is charged and the rest goes back. MedBox24 gives each shop
// up to freeMonthPaise of real AI cost an IST month: it resets, never adds up, and is used before bought tokens.

export const NOT_ENOUGH = 'NOT_ENOUGH_COINS';

type Pricing = Pick<AiSettings, 'targetMargin' | 'packs'>;

export interface Hold {
  coins: number;
  freePaise: number;
  month: string;
}

type FreeState = { freeMonth?: string | null; freeUsedPaise?: number | null } | null;

/** This month's free AI a shop has left, in paise of real cost. */
export const freeLeft = (s: Pick<AiSettings, 'freeMonthPaise'>, w: FreeState, now = new Date()) => Math.max(0, s.freeMonthPaise - (w?.freeMonth === istMonth(now) ? (w.freeUsedPaise ?? 0) : 0));

/** What a job will need before it runs: at most `coins` tokens, `free` paise of this month's free AI first. */
export function quote(s: Pricing & Pick<AiSettings, 'freeMonthPaise'>, w: FreeState, worstPaise: number, now = new Date()) {
  const free = Math.min(freeLeft(s, w, now), worstPaise);
  return { coins: tokensFor(s, worstPaise - free), freePaise: free };
}

const DAY = 86_400_000;

/** When this IST month's free AI comes back: midnight IST on the 1st. */
const resetsOn = (now: Date) => {
  const [y = 0, m = 1] = istMonth(now).split('-').map(Number);
  return new Date(Date.UTC(y, m, 1) - 5.5 * 3_600_000);
};

/** The header's AI line for anyone in the shop: is any AI on, tokens left, this month's free AI used and left. */
export async function meterOf(shopId: Types.ObjectId, now = new Date()) {
  const [s, w] = await Promise.all([aiSettings(now), CoinWalletModel.findOne({ shopId }).select('balance freeMonth freeUsedPaise').lean()]);
  const left = freeLeft(s, w, now);
  return {
    on: (s.enabled && readyFor(s, s.model)) || (s.chat.enabled && readyFor(s, s.chat.model)),
    balance: w?.balance ?? 0,
    free: { usedPaise: s.freeMonthPaise - left, leftPaise: left, monthPaise: s.freeMonthPaise, resetsOn: resetsOn(now) },
  };
}

/**
 * What a shop is told before AI runs: its tokens, this month's free AI left, and what one page or one question takes —
 * `need` after the free AI, `most` without it, `usual` from the real cost of the last 30 days' reads (null before any).
 */
export async function shopAi(shopId: Types.ObjectId, now = new Date()) {
  const [s, w, avg] = await Promise.all([
    aiSettings(now),
    CoinWalletModel.findOne({ shopId }).lean(),
    AiReadModel.aggregate<{ cost: number; pages: number }>([{ $match: { createdAt: { $gte: new Date(now.getTime() - 30 * DAY) }, status: 'done', costPaise: { $gt: 0 } } }, { $group: { _id: null, cost: { $sum: '$costPaise' }, pages: { $sum: '$pages' } } }]),
  ]);
  const [read, chat] = checks(s);
  const free = freeLeft(s, w, now);
  const per = avg[0]?.pages ? Math.ceil(avg[0].cost / avg[0].pages) : null;
  return {
    balance: w?.balance ?? 0,
    free: { leftPaise: free, monthPaise: s.freeMonthPaise, resetsOn: resetsOn(now) },
    page: { need: quote(s, w, read.worstPaise, now).coins, most: read.coins, usual: per === null ? null : tokensFor(s, per) },
    question: { need: quote(s, w, chat.worstPaise, now).coins, most: chat.coins },
  };
}
export type ShopAi = Awaited<ReturnType<typeof shopAi>>;

/** Sets aside a job's worst case, free AI first; too few tokens → NOT_ENOUGH, and nothing is set aside. */
export async function holdJob(shopId: Types.ObjectId, s: AiSettings, worstPaise: number, session: ClientSession, now = new Date()): Promise<Hold> {
  const month = istMonth(now);
  await CoinWalletModel.updateOne({ shopId }, { $setOnInsert: { balance: 0 } }, { upsert: true, session });
  await CoinWalletModel.updateOne({ shopId, freeMonth: { $ne: month } }, { $set: { freeMonth: month, freeUsedPaise: 0 } }, { session });
  const w = await CoinWalletModel.findOne({ shopId }).session(session).lean();
  const q = quote(s, w, worstPaise, now);
  const r = await CoinWalletModel.updateOne({ shopId, balance: { $gte: q.coins }, freeUsedPaise: { $lte: s.freeMonthPaise - q.freePaise } }, { $inc: { balance: -q.coins, held: q.coins, freeUsedPaise: q.freePaise } }, { session });
  if (!r.modifiedCount) {
    const have = w?.balance ?? 0;
    throw AppError.conflict(`Not enough AI tokens — this needs ${String(q.coins)}, the shop has ${String(have)}`, { reason: NOT_ENOUGH, need: q.coins, have });
  }
  return { coins: q.coins, freePaise: q.freePaise, month };
}

/**
 * Charges what the AI really cost (free AI first, never more than was held) and gives back the rest of the hold.
 * `costPaise` 0 when the AI was never reached: nothing is charged. One ledger line when anything was used.
 */
export async function settleJob(shopId: Types.ObjectId, s: Pricing, hold: Hold, costPaise: number, line: { kind: CoinKind; text: string; byName: string; ref: string }, session: ClientSession) {
  const freePaise = Math.min(hold.freePaise, costPaise);
  const coins = Math.min(hold.coins, tokensFor(s, costPaise - freePaise));
  // Free AI held in a month that has since ended is not given back to the new month.
  const sameMonth = Boolean(await CoinWalletModel.exists({ shopId, freeMonth: hold.month }).session(session));
  const w = await CoinWalletModel.findOneAndUpdate(
    { shopId },
    { $inc: { balance: hold.coins - coins, held: -hold.coins, freeTotalPaise: freePaise, ...(sameMonth ? { freeUsedPaise: freePaise - hold.freePaise } : {}) } },
    { session, returnDocument: 'after' },
  ).lean();
  const balance = w?.balance ?? 0;
  if (coins || freePaise) {
    const free = freePaise ? ` · ₹${(freePaise / 100).toFixed(2)} of this month’s free AI` : '';
    await CoinEntryModel.create([{ shopId, kind: line.kind, coins: -coins, balance, text: `${line.text}${free}`, ref: line.ref, byName: line.byName }], { session });
  }
  return { coins, freePaise, balance };
}

/** The end of a failed job's message: what the AI's work took. */
export function tookText(why: string, r: { coins: number; freePaise: number }) {
  const coins = r.coins;
  if (coins > 1) return part(`${why}. The AI’s work took ${String(coins)} tokens`);
  if (coins === 1) return part(`${why}. The AI’s work took 1 token`);
  return r.freePaise ? part(`${why}. This month’s free AI covered it`) : part(`${why}. No tokens were taken`);
}

const LEGACY_PACKS = [
  { code: 'c25', name: 'Starter', coins: 25, price: 29_900 },
  { code: 'c100', name: 'Shop', coins: 100, price: 99_900 },
  { code: 'c500', name: 'Busy shop', coins: 500, price: 449_900 },
];

/**
 * Once: tokens become ₹0.10 each. Packs get price ÷ 10 paise tokens; a shop keeps the value of tokens it bought (at
 * most its balance); free tokens left over go — the monthly free AI replaces them. Older gifts keep their old value
 * for the guard (oldCoinPaise).
 */
export async function tokensToTenPaise(now = new Date()) {
  const stored = await AiSettingsModel.findById('ai').select('tokensAt packs').lean();
  if (stored?.tokensAt) return 0;
  // Never saved: the shops bought from the packs that were the default before D109.
  const old = stored?.packs?.length ? stored.packs.map((p) => ({ code: p.code ?? '', name: p.name ?? '', coins: p.coins ?? 0, price: p.price ?? 0 })) : LEGACY_PACKS;
  const oldCoin = coinValue({ packs: old });
  const packs = old.map((p) => ({ ...p, coins: Math.round(p.price / TOKEN_PRICE_PAISE) }));
  const newCoin = coinValue({ packs });
  const bought = await CoinEntryModel.aggregate<{ _id: Types.ObjectId; coins: number }>([{ $match: { shopId: { $exists: true }, kind: 'purchase' } }, { $group: { _id: '$shopId', coins: { $sum: '$coins' } } }]);
  const wallets = await CoinWalletModel.find({ shopId: { $exists: true }, balance: { $gt: 0 } }).lean();
  let changed = 0;
  for (const w of wallets) {
    const paid = Math.min(w.balance, bought.find((b) => String(b._id) === String(w.shopId))?.coins ?? 0);
    const next = Math.round((paid * oldCoin) / Math.max(1, newCoin));
    await inTransaction(async (session) => {
      const r = await CoinWalletModel.updateOne({ _id: w._id, shopId: w.shopId, balance: w.balance }, { $set: { balance: next }, $inc: { oldFreeGone: w.balance - paid } }, { session });
      if (!r.modifiedCount) return;
      const text = paid ? `Tokens are now ₹0.10 each: ${String(paid)} bought tokens = ${String(next)} new tokens; free tokens left (${String(w.balance - paid)}) replaced by free AI every month` : `Tokens are now ₹0.10 each: free tokens left (${String(w.balance)}) replaced by free AI every month`;
      await CoinEntryModel.create([{ shopId: w.shopId, kind: 'convert', coins: next - w.balance, balance: next, text, ref: 'D109', byName: 'MedBox24' }], { session });
      changed += 1;
    });
  }
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { packs, welcomeCoins: 0, tokensAt: now, oldCoinPaise: oldCoin } }, { upsert: true });
  logger.info({ wallets: changed, oldCoin, newCoin }, 'AI tokens are now ₹0.10 each');
  return changed;
}
