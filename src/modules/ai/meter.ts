import type { ClientSession, Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { part } from '../../core/lang';
import { inTransaction } from '../../core/transaction';
import { logger } from '../../config/logger';
import { istMonth } from '../../utils/date';
import { aiSettings, readyFor, type AiSettings } from './ai-settings';
import { AskQuestionModel } from '../ask/ask.model';
import { AiReadModel, AiSettingsModel, CoinEntryModel, CoinWalletModel, type CoinKind } from './ai.model';
import { checks, coinValue, tokensFor } from './guard';

// D109: AI is paid by what it really used — its cost × the margin, at what a token brings in (GST out), rounded up.
// Before a job runs its worst case is set aside (this month's free AI first, then tokens), so a job never runs on
// tokens the shop doesn't have; afterwards the real cost is charged and the rest goes back. MedBox24 gives each shop
// freeMonthPaise worth of tokens an IST month (₹10 = 1,000 tokens): it resets, never adds up, and is used before
// bought tokens. Inside, the free AI is counted in real AI cost — those tokens' worth, GST and the margin taken out.

export const NOT_ENOUGH = 'NOT_ENOUGH_COINS';

type Pricing = Pick<AiSettings, 'targetMargin' | 'packs'>;

export interface Hold {
  coins: number;
  freePaise: number;
  month: string;
  /** 1 for a hold in ₹0.01 tokens; unset for one in ₹0.10 tokens (made before tokens moved). */
  tokenPaise?: number | null;
}

/**
 * Once ₹0.01 tokens are on: this shop's wallet moves the first time anything touches it — balance and held × 10, the
 * same money, one ledger line. True when ₹0.01 tokens are on (the wallet is then in them).
 */
export async function ensurePaise(shopId: Types.ObjectId, session?: ClientSession) {
  if (!(await AiSettingsModel.exists({ _id: 'ai', paiseAt: { $type: 'date' } }).session(session ?? null))) return false;
  await CoinWalletModel.updateOne({ shopId }, { $setOnInsert: { balance: 0, held: 0, tokenPaise: 1 } }, { upsert: true, session });
  for (let tries = 0; tries < 5; tries += 1) {
    const w = await CoinWalletModel.findOne({ shopId }).select('balance held tokenPaise').session(session ?? null).lean();
    if (!w || w.tokenPaise === 1) return true;
    const r = await CoinWalletModel.updateOne({ shopId, balance: w.balance, held: w.held, tokenPaise: { $ne: 1 } }, { $set: { balance: w.balance * 10, held: w.held * 10, tokenPaise: 1 } }, { session });
    if (!r.modifiedCount) continue;
    if (w.balance > 0) {
      const text = `Tokens are now ₹0.01 each (₹1 = 100 tokens): ${String(w.balance)} tokens = ${String(w.balance * 10)} tokens, the same money`;
      await CoinEntryModel.create([{ shopId, kind: 'convert', coins: w.balance * 9, balance: w.balance * 10, text, ref: 'paise', byName: 'MedBox24' }], { session: session ?? null });
    }
    return true;
  }
  throw AppError.conflict('The AI tokens are busy — try again');
}

/** A hold's tokens in the wallet's tokens: one set aside as ₹0.10 tokens is 10 times as many ₹0.01 ones. */
const heldNow = (hold: Hold, paise: boolean) => (paise && hold.tokenPaise !== 1 ? hold.coins * 10 : hold.coins);

type FreeState = { freeMonth?: string | null; freeUsedPaise?: number | null } | null;

type FreePricing = Pricing & Pick<AiSettings, 'freeMonthPaise'>;
/** A token's price in the cheapest pack, GST in (1 paisa). */
const tokenPrice = (s: Pick<AiSettings, 'packs'>) => Math.min(...s.packs.map((k) => k.price / Math.max(1, k.coins)));
/** The month's free tokens as real AI cost: ₹10 of tokens → 1,000 × 0.84 ÷ 1.5 = ₹5.60 of AI. */
export const freeBudget = (s: FreePricing) => Math.floor((s.freeMonthPaise * coinValue(s)) / tokenPrice(s) / s.targetMargin);
/** This month's free AI a shop has left, in paise of real cost. */
export const freeLeft = (s: FreePricing, w: FreeState, now = new Date()) => Math.max(0, freeBudget(s) - (w?.freeMonth === istMonth(now) ? (w.freeUsedPaise ?? 0) : 0));

/** What a job will need before it runs: at most `coins` tokens, `free` paise of this month's free AI first. */
export function quote(s: FreePricing, w: FreeState, worstPaise: number, now = new Date()) {
  const free = Math.min(freeLeft(s, w, now), worstPaise);
  return { coins: tokensFor(s, worstPaise - free), freePaise: free };
}

const DAY = 86_400_000;

/** Free AI (real cost) as the tokens it stands for: the cost × margin ÷ a token's worth. */
const freeTokens = (s: Pricing, paise: number) => (paise > 0 ? Math.max(1, Math.round((paise * s.targetMargin) / coinValue(s))) : 0);
/** The month's free tokens as the shop sees them, and how many are left. */
const freeShown = (s: FreePricing, left: number) => {
  const tokens = Math.round(s.freeMonthPaise / tokenPrice(s));
  return { tokens, tokensLeft: left >= freeBudget(s) ? tokens : Math.min(tokens, freeTokens(s, left)) };
};

/** When this IST month's free AI comes back: midnight IST on the 1st. */
const resetsOn = (now: Date) => {
  const [y = 0, m = 1] = istMonth(now).split('-').map(Number);
  return new Date(Date.UTC(y, m, 1) - 5.5 * 3_600_000);
};

/** The header's AI line for anyone in the shop: is any AI on, tokens left, this month's free AI used and left. */
export async function meterOf(shopId: Types.ObjectId, now = new Date()) {
  await ensurePaise(shopId);
  const [s, w] = await Promise.all([aiSettings(now), CoinWalletModel.findOne({ shopId }).select('balance freeMonth freeUsedPaise').lean()]);
  const left = freeLeft(s, w, now);
  return {
    on: (s.enabled && readyFor(s, s.model)) || (s.chat.enabled && readyFor(s, s.chat.model)),
    balance: w?.balance ?? 0,
    free: { usedPaise: freeBudget(s) - left, leftPaise: left, monthPaise: freeBudget(s), resetsOn: resetsOn(now), ...freeShown(s, left) },
  };
}

/**
 * What a shop is told before AI runs: its tokens, this month's free AI left, and what one page or one question takes —
 * `need` after the free AI, `most` without it, `usual` from the real cost of the last 30 days' reads (null before any).
 */
export async function shopAi(shopId: Types.ObjectId, now = new Date()) {
  await ensurePaise(shopId);
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
    free: { leftPaise: free, monthPaise: freeBudget(s), resetsOn: resetsOn(now), ...freeShown(s, free) },
    page: { need: quote(s, w, read.worstPaise, now).coins, most: read.coins, usual: per === null ? null : tokensFor(s, per) },
    question: { need: quote(s, w, chat.worstPaise, now).coins, most: chat.coins },
  };
}
export type ShopAi = Awaited<ReturnType<typeof shopAi>>;

/** Sets aside a job's worst case, free AI first; too few tokens → NOT_ENOUGH, and nothing is set aside. */
export async function holdJob(shopId: Types.ObjectId, s: AiSettings, worstPaise: number, session: ClientSession, now = new Date()): Promise<Hold> {
  const paise = await ensurePaise(shopId, session);
  const month = istMonth(now);
  await CoinWalletModel.updateOne({ shopId }, { $setOnInsert: { balance: 0 } }, { upsert: true, session });
  await CoinWalletModel.updateOne({ shopId, freeMonth: { $ne: month } }, { $set: { freeMonth: month, freeUsedPaise: 0 } }, { session });
  const w = await CoinWalletModel.findOne({ shopId }).session(session).lean();
  const q = quote(s, w, worstPaise, now);
  const r = await CoinWalletModel.updateOne({ shopId, balance: { $gte: q.coins }, freeUsedPaise: { $lte: freeBudget(s) - q.freePaise } }, { $inc: { balance: -q.coins, held: q.coins, freeUsedPaise: q.freePaise } }, { session });
  if (!r.modifiedCount) {
    const have = w?.balance ?? 0;
    throw AppError.conflict(`Not enough AI tokens — this needs ${String(q.coins)}, the shop has ${String(have)}`, { reason: NOT_ENOUGH, need: q.coins, have });
  }
  return { coins: q.coins, freePaise: q.freePaise, month, tokenPaise: paise ? 1 : null };
}

/**
 * Charges what the AI really cost (free AI first, never more than was held) and gives back the rest of the hold.
 * `costPaise` 0 when the AI was never reached: nothing is charged. One ledger line when anything was used.
 */
export async function settleJob(shopId: Types.ObjectId, s: Pricing, hold: Hold, costPaise: number, line: { kind: CoinKind; text: string; byName: string; ref: string }, session: ClientSession) {
  const held = heldNow(hold, await ensurePaise(shopId, session));
  const freePaise = Math.min(hold.freePaise, costPaise);
  const coins = Math.min(held, tokensFor(s, costPaise - freePaise));
  // Free AI held in a month that has since ended is not given back to the new month.
  const sameMonth = Boolean(await CoinWalletModel.exists({ shopId, freeMonth: hold.month }).session(session));
  const w = await CoinWalletModel.findOneAndUpdate(
    { shopId },
    { $inc: { balance: held - coins, held: -held, freeTotalPaise: freePaise, ...(sameMonth ? { freeUsedPaise: freePaise - hold.freePaise } : {}) } },
    { session, returnDocument: 'after' },
  ).lean();
  const balance = w?.balance ?? 0;
  if (coins || freePaise) {
    const freeN = freeTokens(s, freePaise);
    const free = freeN ? ` · ${String(freeN)} of this month’s free tokens` : '';
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
  const packs = old.map((p) => ({ ...p, coins: Math.round(p.price / 10) }));
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

/**
 * Once, after ₹0.10 tokens: tokens become ₹0.01 each (₹1 = 100 tokens). The packs × 10 at once, then every wallet
 * (ensurePaise — any wallet touched first moves by itself). A hold keeps the tokens it was made in, so a job running
 * across the move settles right, and an order keeps its own: nothing waits and no AI is paused.
 */
export async function tokensToOnePaise(now = new Date()) {
  const st = await AiSettingsModel.findById('ai').select('tokensAt paiseAt packs tokensMoving').lean();
  if (!st?.tokensAt) return 0;
  if (!st.paiseAt) {
    // v1.60.0–1.60.3 moved some wallets with their stopped jobs' holds already × 10: those holds are in ₹0.01 tokens.
    const moved = await CoinWalletModel.find({ shopId: { $exists: true }, tokenPaise: 1 }).select('shopId').lean();
    const shops = moved.map((w) => w.shopId);
    if (shops.length) {
      const was = { shopId: { $in: shops }, status: 'running' as const, hold: { $exists: true }, 'hold.tokenPaise': { $exists: false } };
      await AiReadModel.updateMany(was, { $set: { 'hold.tokenPaise': 1 } });
      await AskQuestionModel.updateMany(was, { $set: { 'hold.tokenPaise': 1 } });
    }
    const old = (st.packs ?? []).map((p) => ({ code: p.code ?? '', name: p.name ?? '', coins: p.coins ?? 0, price: p.price ?? 0 }));
    const packs = old.map((p) => ({ ...p, coins: p.coins * 10 }));
    await AiSettingsModel.updateOne({ _id: 'ai', paiseAt: { $exists: false } }, { $set: { packs, paiseAt: now, tenCoinPaise: old.length ? coinValue({ packs: old }) : null }, $unset: { tokensMoving: 1 } });
    logger.info({ wallets: shops.length }, 'AI tokens are now ₹0.01 each');
  } else if (st.tokensMoving) await AiSettingsModel.updateOne({ _id: 'ai' }, { $unset: { tokensMoving: 1 } });
  let moved = 0;
  for (const w of await CoinWalletModel.find({ shopId: { $exists: true }, tokenPaise: { $ne: 1 } }).select('shopId').limit(500).lean()) {
    await inTransaction((session) => ensurePaise(w.shopId, session));
    moved += 1;
  }
  return moved;
}
