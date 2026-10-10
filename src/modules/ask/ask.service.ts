import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { z } from 'zod';
import { logger } from '../../config/logger';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { signal } from '../../services/monitor';
import { istDayStart, istMonth } from '../../utils/date';
import { aiSettings, apiKey, priceOf, type AiSettings } from '../ai/ai-settings';
import { CoinWalletModel } from '../ai/ai.model';
import { moveCoins } from '../ai/coins';
import { audit } from '../audit/audit.model';
import { can } from '../rbac/permissions';
import type { Actor } from '../user/actor';
import { askClaude, costOf, type Turn, type Usage } from './ask-ai';
import { AskQuestionModel } from './ask.model';
import * as C from './cards';
import * as F from './facts';
import { bareName, matchIntent, type Intent } from './intents';
import { LANGS, langOf, voiceOf, type Voice } from './lang';
import { CHIPS, TEXT, say } from './texts';

// D81 "Ask your shop": free first (the software answers), AI only when the shop says yes, inside the admin's caps.

export const askSchema = z
  .object({
    text: z.string().trim().min(1, 'Type a question').max(300, 'Keep the question under 300 letters'),
    lang: z.enum(LANGS).optional(),
    /** The shop said yes to spending a coin (or a free question) on the AI. */
    confirm: z.boolean().optional(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(600) }).strict()).max(8).optional(),
  })
  .strict();
export type AskInput = z.infer<typeof askSchema>;

const NOT_ENOUGH = 'NOT_ENOUGH_COINS';

async function cardOf(t: TenantContext, userId: string, intent: Intent, v: Voice, now: Date): Promise<C.Card> {
  try {
    switch (intent.kind) {
      case 'sales':
        return C.salesCard(await F.sales(t, userId, intent.period, now), v);
      case 'profit':
        return C.profitCard(await F.profit(t, userId, intent.period, now), v);
      case 'top':
        return C.topCard(await F.topItems(t, userId, intent.period, now), v);
      case 'stock':
        return intent.name ? C.stockCard(await F.stockOf(t, intent.name), v) : C.stockSummaryCard(await F.stockSummary(t), v);
      case 'low':
        return C.lowCard(await F.lowStock(t), v);
      case 'expiring':
        return C.expiringCard(await F.expiring(t, intent.days, now), v);
      case 'expired':
        return C.expiredCard(await F.expired(t, now), v);
      case 'udhaar':
        return C.udhaarCard(await F.udhaarOf(t, intent.name), v);
      case 'suppliers':
        return C.suppliersCard(await F.supplierDues(t, intent.name, now), v);
      case 'salt':
        return C.saltCard(await F.sameSalt(t, intent.name), v);
      case 'cash':
        return C.cashCard(await F.cashToday(t, now), v);
      case 'help':
        return C.helpCard(v);
    }
  } catch (err) {
    if (err instanceof F.NoAccess) return C.noteCard('', say(TEXT.noPermission, v));
    throw err;
  }
}

/** "Dolo 650" on its own is a stock question — when the shop has such a product. */
async function bareStock(t: TenantContext, text: string): Promise<Intent | null> {
  const name = bareName(text);
  if (!name || !(can(t.permissions, 'products', 'view') || can(t.permissions, 'stock', 'view'))) return null;
  return (await F.stockOf(t, name)).found ? { kind: 'stock', name } : null;
}

// This month's chat spend, kept for a minute and topped up by every answer, so the budget check costs no query.
const spent = { month: '', at: 0, paise: 0 };
async function spentThisMonth(now: Date) {
  const month = istMonth(now);
  if (spent.month === month && now.getTime() - spent.at < 60_000) return spent.paise;
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  const from = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3_600_000);
  const [r] = await AskQuestionModel.aggregate<{ paise: number }>([{ $match: { createdAt: { $gte: from } } }, { $group: { _id: null, paise: { $sum: '$costPaise' } } }]);
  Object.assign(spent, { month, at: now.getTime(), paise: r?.paise ?? 0 });
  return spent.paise;
}
/** Tests start each case from a clean month. */
export const forgetSpend = () => Object.assign(spent, { month: '', at: 0, paise: 0 });

type Stop = 'aiOff' | 'shopOff' | 'ownerOnly' | 'budget' | 'dayLimit';
type Wallet = { askAi?: boolean | null } | null;

async function stopOf(t: TenantContext, s: AiSettings, w: Wallet, now: Date): Promise<Stop | null> {
  if (!s.chat.enabled || !s.hasKey) return 'aiOff';
  if (!w?.askAi) return 'shopOff';
  if (!can(t.permissions, 'reports', 'view')) return 'ownerOnly';
  if ((await spentThisMonth(now)) >= s.chat.budgetUsd * s.usdInr * 100) return 'budget';
  const today = await AskQuestionModel.countDocuments({ shopId: t.shopId, route: { $in: ['ai', 'off_topic'] }, createdAt: { $gte: istDayStart(now) } });
  if (today >= s.chat.perShopDay) return 'dayLimit';
  return null;
}

/** What the chat shows up top: is AI on for this person, what a question costs, free questions left, coins. */
export async function offer(t: TenantContext, now = new Date()) {
  const [s, w] = await Promise.all([aiSettings(), CoinWalletModel.findOne({ shopId: t.shopId }).lean()]);
  const stop = await stopOf(t, s, w, now);
  return {
    ai: { on: s.chat.enabled && s.hasKey, shopOn: Boolean(w?.askAi), canSwitch: can(t.permissions, 'subscription', 'edit'), stop, coinsPerQuestion: s.chat.coinsPerQuestion, freeLeft: Math.max(0, s.chat.freeQuestions - (w?.askFree ?? 0)), balance: w?.balance ?? 0 },
    chips: CHIPS,
  };
}

/** The owner's switch for AI answers in this shop; every change is in the shop's audit log with who and when. */
export async function switchAi(t: TenantContext, actor: Actor, on: boolean, ip?: string) {
  await inTransaction(async (session) => {
    const w = await CoinWalletModel.findOne({ shopId: t.shopId }).session(session).lean();
    if (Boolean(w?.askAi) === on) return;
    await CoinWalletModel.updateOne({ shopId: t.shopId }, { $set: { askAi: on, askAiBy: actor.name, askAiAt: new Date() }, $setOnInsert: { balance: 0, askFree: 0 } }, { upsert: true, session });
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'settings', entityId: String(t.shopId), entityName: 'AI answers', text: `${actor.name} turned AI answers ${on ? 'on' : 'off'}`, changes: { before: { askAi: Boolean(w?.askAi) }, after: { askAi: on } }, ip }, session);
  });
  return offer(t);
}

const stopText = (stop: Stop, s: AiSettings, v: Voice) => say(TEXT[stop], v, { n: s.chat.perShopDay });
const costText = (o: Awaited<ReturnType<typeof offer>>['ai'], v: Voice) => (o.freeLeft > 0 ? say(TEXT.free, v, { n: o.freeLeft - 1 }) : o.coinsPerQuestion === 1 ? say(TEXT.coin, v) : say(TEXT.coins, v, { n: o.coinsPerQuestion }));

/** Alternating turns that end with the assistant, so the new question follows on. */
function turnsOf(history: AskInput['history']): Turn[] {
  const out: Turn[] = [];
  for (const h of history ?? []) {
    if (!out.length && h.role === 'assistant') continue;
    if (out.at(-1)?.role === h.role) continue;
    out.push({ role: h.role, text: h.text });
  }
  if (out.at(-1)?.role === 'user') out.pop();
  return out.slice(-8);
}

export async function ask(t: TenantContext, actor: Actor, input: AskInput, now = new Date()) {
  const voice = voiceOf(input.text, input.lang);
  const who = { shopId: t.shopId, shopName: t.shopName, userId: new Types.ObjectId(actor.id), userName: actor.name, voice };
  const suggestions = CHIPS[langOf(voice)].slice(0, 4);

  const intent = matchIntent(input.text) ?? (await bareStock(t, input.text));
  if (intent) {
    const card = await cardOf(t, actor.id, intent, voice, now);
    await AskQuestionModel.create({ ...who, route: 'free', intent: intent.kind });
    return { route: 'free' as const, voice, cards: [card] };
  }

  const s = await aiSettings();
  if (!input.confirm) {
    const o = (await offer(t, now)).ai;
    await AskQuestionModel.create({ ...who, route: 'unmatched' });
    return { route: 'needs_ai' as const, voice, text: o.stop ? stopText(o.stop, s, voice) : say(TEXT.needsAi, voice, { cost: costText(o, voice) }), canAsk: !o.stop, ai: o, suggestions };
  }

  const stop = await stopOf(t, s, await CoinWalletModel.findOne({ shopId: t.shopId }).lean(), now);
  const key = stop ? null : await apiKey();
  if (stop || !key) {
    if (stop === 'budget') await signal('ask_budget', now);
    await AskQuestionModel.create({ ...who, route: 'blocked', intent: stop ?? 'aiOff' });
    return { route: 'blocked' as const, voice, text: stopText(stop ?? 'aiOff', s, voice), suggestions };
  }

  // Hold the price first: a free question if any are left, else coins. Both come back if no answer is given.
  await CoinWalletModel.updateOne({ shopId: t.shopId }, { $setOnInsert: { balance: 0, askFree: 0 } }, { upsert: true });
  let held: { id: Types.ObjectId; free: boolean; coins: number };
  try {
    held = await inTransaction(async (session) => {
      const free = await CoinWalletModel.findOneAndUpdate({ shopId: t.shopId, askFree: { $lt: s.chat.freeQuestions } }, { $inc: { askFree: 1 } }, { session, returnDocument: 'after' }).lean();
      const coins = free ? 0 : s.chat.coinsPerQuestion;
      const [doc] = await AskQuestionModel.create([{ ...who, route: 'ai', status: 'running', free: Boolean(free), coins, model: s.chat.model }], { session });
      if (!doc) throw AppError.internal();
      if (!free) await moveCoins(t.shopId, 'ask', -coins, 'AI question', actor.name, String(doc._id), session);
      return { id: doc._id, free: Boolean(free), coins };
    });
  } catch (err) {
    if (!(err instanceof AppError && (err.details as { reason?: string } | undefined)?.reason === NOT_ENOUGH)) throw err;
    await AskQuestionModel.create({ ...who, route: 'blocked', intent: 'noCoins' });
    return { route: 'blocked' as const, voice, text: say(TEXT.noCoins, voice), suggestions };
  }

  const used: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const started = Date.now();
  const back = held.free ? say(TEXT.backFree, voice) : say(TEXT.back, voice);
  let answer: Awaited<ReturnType<typeof askClaude>>;
  try {
    answer = await askClaude({ t, userId: actor.id, now }, key, { model: s.chat.model, capIn: s.chat.capIn, capOut: s.chat.capOut }, voice, input.text, turnsOf(input.history), used);
  } catch (err) {
    logger.warn({ err: err instanceof Anthropic.APIError ? { status: typeof err.status === 'number' ? err.status : null, type: err.name } : String(err) }, 'AI chat question failed');
    await signal('ai_fail', now);
    await settle(t, actor, held, { status: 'failed', error: err instanceof Anthropic.APIError ? `Anthropic ${String(err.status)}` : 'Not reached', refund: true }, used, s, started);
    return { route: 'failed' as const, voice, text: say(TEXT.failed, voice, { back }), suggestions };
  }
  const tools = answer.tools;
  if (answer.kind === 'answer') {
    const after = await settle(t, actor, held, { status: 'done', tools, refund: false }, used, s, started);
    return { route: 'ai' as const, voice, text: answer.text, links: answer.links.map((href) => ({ label: say(TEXT.open, voice), href })), ai: after };
  }
  if (answer.kind === 'off_topic') {
    const after = await settle(t, actor, held, { status: 'done', route: 'off_topic', tools, refund: true }, used, s, started);
    return { route: 'off_topic' as const, voice, text: say(TEXT.offTopic, voice), ai: after, suggestions };
  }
  const why = answer.kind === 'too_big' ? 'Over the cap' : 'Refused';
  const after = await settle(t, actor, held, { status: 'failed', error: why, tools, refund: true }, used, s, started);
  return { route: 'failed' as const, voice, text: say(answer.kind === 'too_big' ? TEXT.tooBig : TEXT.failed, voice, { back }), ai: after, suggestions };
}

/** Records the tokens and real cost; gives the coin (or free question) back when asked to — exactly once. */
async function settle(t: TenantContext, actor: Actor, held: { id: Types.ObjectId; free: boolean; coins: number }, how: { status: 'done' | 'failed'; route?: 'off_topic'; error?: string; tools?: string[]; refund: boolean }, used: Usage, s: AiSettings, started: number) {
  const cost = costOf(used, priceOf(s, s.chat.model), s.usdInr);
  spent.paise += cost;
  await inTransaction(async (session) => {
    const claimed = await AskQuestionModel.updateOne(
      { _id: held.id, status: 'running' },
      { $set: { status: how.status, ...(how.route ? { route: how.route } : {}), refunded: how.refund, error: how.error, tools: how.tools, inputTokens: used.input, outputTokens: used.output, cacheReadTokens: used.cacheRead, cacheWriteTokens: used.cacheWrite, costPaise: cost, ms: Date.now() - started } },
      { session },
    );
    if (!claimed.modifiedCount || !how.refund) return;
    if (held.free) await CoinWalletModel.updateOne({ shopId: t.shopId, askFree: { $gt: 0 } }, { $inc: { askFree: -1 } }, { session });
    else await moveCoins(t.shopId, 'refund', held.coins, `Back: AI question — ${how.error ?? 'not about the shop'}`, actor.name, String(held.id), session);
  });
  const w = await CoinWalletModel.findOne({ shopId: t.shopId }).lean();
  return { balance: w?.balance ?? 0, freeLeft: Math.max(0, s.chat.freeQuestions - (w?.askFree ?? 0)) };
}

/** Questions left "running" by a restart give their coin or free question back (scheduler). */
export async function settleStuckQuestions(now = new Date()) {
  const stuck = await AskQuestionModel.find({ status: 'running', createdAt: { $lt: new Date(now.getTime() - 10 * 60_000) } }).lean();
  for (const q of stuck) {
    await inTransaction(async (session) => {
      const claimed = await AskQuestionModel.updateOne({ _id: q._id, status: 'running' }, { $set: { status: 'failed', refunded: true, error: 'Stopped before it finished' } }, { session });
      if (!claimed.modifiedCount) return;
      if (q.free) await CoinWalletModel.updateOne({ shopId: q.shopId, askFree: { $gt: 0 } }, { $inc: { askFree: -1 } }, { session });
      else await moveCoins(q.shopId, 'refund', q.coins, 'Back: AI question — it stopped before it finished', 'MedShop', String(q._id), session);
    });
  }
  return stuck.length;
}
