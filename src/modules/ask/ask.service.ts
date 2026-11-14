import { month as payrollMonth } from '../payroll/payroll.service';
import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { z } from 'zod';
import { logger } from '../../config/logger';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { signal } from '../../services/monitor';
import { istDayStart, istMonth } from '../../utils/date';
import { aiSettings, apiKey, onFreeTier, priceOf, providerOf, readyFor, type AiSettings } from '../ai/ai-settings';
import { GeminiError } from '../../services/gemini';
import { fits, safeNow, worstQuestion } from '../ai/guard';
import { outOfCredit } from '../ai/credits';
import { CoinWalletModel } from '../ai/ai.model';
import { moveCoins } from '../ai/coins';
import { ensurePaise, freeLeft, holdJob, quote, settleJob, shopAi, type Hold } from '../ai/meter';
import { audit } from '../audit/audit.model';
import { brief } from '../brief/brief.service';
import { can } from '../rbac/permissions';
import type { Actor } from '../user/actor';
import { askClaude, askGemini, costOf, type Turn, type Usage } from './ask-ai';
import { AskQuestionModel } from './ask.model';
import * as C from './cards';
import * as F from './facts';
import { bareName, matchIntent, quantityName, type Intent } from './intents';
import { LANGS, langOf, voiceOf, type Voice } from './lang';
import { AI_GROUP, CHIPS, CHIP_GROUPS, TEXT, say } from './texts';

// D81 "Ask your shop": ready answers first (no AI, free); anything else goes straight to the AI for a token, inside the admin's caps.

export const askSchema = z
  .object({
    text: z.string().trim().min(1, 'Type a question').max(300, 'Keep the question under 300 letters'),
    lang: z.enum(LANGS).optional(),
    /** Older apps asked first; the AI now answers without it. */
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
      case 'expenses':
        return C.expensesCard(await F.expensesIn(t, intent.period, now), v);
      case 'purchases':
        return C.purchasesCard(await F.purchasesIn(t, intent.period, now), v);
      case 'price':
        return C.priceCard(await F.priceOf(t, intent.name), v);
      case 'dead':
        return C.deadCard(await F.notSelling(t, intent.days, now), v);
      case 'customers':
        return C.customersCard(await F.topCustomers(t, userId, intent.period, now), v);
      case 'modes':
        return C.modesCard(await F.payModes(t, userId, intent.period, now), v);
      case 'orders':
        return C.ordersCard(await F.openOrders(t), v);
      case 'gst':
        return C.gstCard(await F.gstOf(t, intent.last, now), v);
      case 'staff':
        return C.staffCard(await F.staffSales(t, intent.period, now), v);
      case 'compare':
        return C.compareCard(await F.compare(t, userId, intent.key, now), v);
      case 'margins':
        return C.marginsCard(await F.itemMargins(t, userId, intent.period, intent.order, now), v);
      case 'cheaper':
        return C.cheaperCard(await F.buyPrices(t, intent.name, now), v);
      case 'busy':
        return C.busyCard(await F.busyHours(t, userId, intent.period, now), v);
      case 'payroll': {
        if (!t.features.includes('payroll')) return C.noteCard('', say(TEXT.notInPlan, v));
        if (!can(t.permissions, 'payroll', 'view')) throw new F.NoAccess();
        const ist = new Date(now.getTime() + 5.5 * 3_600_000);
        const m = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - (intent.last ? 1 : 0), 1)).toISOString().slice(0, 7);
        return C.payrollCard(await payrollMonth(t, m, now), v);
      }
      case 'brief':
        if (!t.features.includes('brief')) return C.noteCard('', say(TEXT.notInPlan, v));
        if (!can(t.permissions, 'reports', 'view')) throw new F.NoAccess();
        return C.briefCard(await brief(t, userId, now), v);
    }
  } catch (err) {
    if (err instanceof F.NoAccess) return C.noteCard('', say(TEXT.noPermission, v));
    throw err;
  }
}

/** "Dolo 650" on its own, or "how much condom do I have", is a stock question — when the shop has such a product. */
async function bareStock(t: TenantContext, text: string): Promise<Intent | null> {
  const name = bareName(text) ?? quantityName(text);
  if (!name || !(can(t.permissions, 'products', 'view') || can(t.permissions, 'stock', 'view'))) return null;
  return (await F.stockOf(t, name)).found ? { kind: 'stock', name } : null;
}

// This month's chat spend, kept for a minute and topped up by every answer, so the budget check costs no query.
const spent = { month: '', at: 0, paise: 0 };
export async function spentThisMonth(now: Date) {
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

type Stop = 'aiOff' | 'plan' | 'shopOff' | 'ownerOnly' | 'noCoins' | 'paused' | 'budget' | 'dayLimit';
type Wallet = { askAi?: boolean | null; balance?: number | null; freeMonth?: string | null; freeUsedPaise?: number | null } | null;

async function stopOf(t: TenantContext, s: AiSettings, w: Wallet, now: Date): Promise<Stop | null> {
  if (!s.chat.enabled || !readyFor(s, s.chat.model)) return 'aiOff';
  if (!t.features.includes('ai')) return 'plan';
  if (!w?.askAi) return 'shopOff';
  if (!can(t.permissions, 'reports', 'view')) return 'ownerOnly';
  if ((w.balance ?? 0) < quote(s, w, worstQuestion(s), now).coins) return 'noCoins';
  if ((await spentThisMonth(now)) >= s.chat.budgetUsd * s.usdInr * 100) return 'budget';
  const today = await AskQuestionModel.countDocuments({ shopId: t.shopId, route: { $in: ['ai', 'off_topic'] }, createdAt: { $gte: istDayStart(now) } });
  if (today >= s.chat.perShopDay) return 'dayLimit';
  // D97: never at a price that could lose money, nor past what this shop has paid for.
  if (!safeNow(s, 'chat') || !(await fits(t.shopId, s, worstQuestion(s), freeLeft(s, w, now)))) return 'paused';
  return null;
}

/** What the chat shows up top: is AI on for this person, what a question takes at most (D109), tokens and free AI left. */
export async function offer(t: TenantContext, now = new Date()) {
  await ensurePaise(t.shopId);
  const [s, w, mine] = await Promise.all([aiSettings(), CoinWalletModel.findOne({ shopId: t.shopId }).lean(), shopAi(t.shopId, now)]);
  const stop = await stopOf(t, s, w, now);
  return {
    ai: { on: s.chat.enabled && readyFor(s, s.chat.model), shopOn: Boolean(w?.askAi), canSwitch: can(t.permissions, 'subscription', 'edit'), stop, coinsPerQuestion: mine.question.need, mostPerQuestion: mine.question.most, free: mine.free, balance: w?.balance ?? 0 },
    chips: CHIPS,
    groups: CHIP_GROUPS,
    aiGroup: AI_GROUP,
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

  // No ready answer: straight to the AI, a token a question (given back when it is not about the shop or fails).
  const s = await aiSettings();
  await ensurePaise(t.shopId);
  const stop = await stopOf(t, s, await CoinWalletModel.findOne({ shopId: t.shopId }).lean(), now);
  const provider = providerOf(s.chat.model);
  const key = stop ? null : await apiKey(provider);
  if (stop || !key) {
    if (stop === 'budget') await signal('ask_budget', now);
    if (stop === 'paused') await signal('ai_paused', now);
    await AskQuestionModel.create({ ...who, route: 'blocked', intent: stop ?? 'aiOff' });
    return { route: 'blocked' as const, voice, text: stopText(stop ?? 'aiOff', s, voice), suggestions };
  }

  // D109: the shop is told what the question may take and says yes first; nothing is asked or set aside before that.
  if (!input.confirm) {
    const mine = await shopAi(t.shopId, now);
    return { route: 'confirm' as const, voice, need: mine.question.need, most: mine.question.most, free: mine.free, balance: mine.balance };
  }

  // The worst case is set aside first; the real cost is charged after, the rest goes back.
  let held: { id: Types.ObjectId; hold: Hold };
  try {
    held = await inTransaction(async (session) => {
      const hold = await holdJob(t.shopId, s, worstQuestion(s), session, now);
      const [doc] = await AskQuestionModel.create([{ ...who, route: 'ai', status: 'running', free: false, coins: hold.coins, hold, model: s.chat.model }], { session });
      if (!doc) throw AppError.internal();
      return { id: doc._id, hold };
    });
  } catch (err) {
    if (!(err instanceof AppError && (err.details as { reason?: string } | undefined)?.reason === NOT_ENOUGH)) throw err;
    await AskQuestionModel.create({ ...who, route: 'blocked', intent: 'noCoins' });
    return { route: 'blocked' as const, voice, text: say(TEXT.noCoins, voice), suggestions };
  }

  const used: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const started = Date.now();
  // What the AI's work took, for the shop to read: tokens, the month's free AI, or nothing.
  const took = (r: { coins: number; freePaise: number }) => (r.coins ? say(TEXT.took, voice, { n: r.coins }) : r.freePaise ? say(TEXT.freeTook, voice) : say(TEXT.back, voice));
  let answer: Awaited<ReturnType<typeof askClaude>>;
  try {
    answer = await (provider === 'google' ? askGemini : askClaude)({ t, userId: actor.id, now }, key, { model: s.chat.model, capIn: s.chat.capIn, capOut: s.chat.capOut, price: priceOf(s, s.chat.model) }, voice, input.text, turnsOf(input.history), used);
  } catch (err) {
    logger.warn({ err: err instanceof Anthropic.APIError ? { status: typeof err.status === 'number' ? err.status : null, type: err.name } : err instanceof GeminiError ? { status: err.status, type: err.kind } : String(err) }, 'AI chat question failed');
    await signal(outOfCredit(err) ? 'ai_credit_low' : 'ai_fail', now);
    const after = await settle(t, actor, held, { status: 'failed', error: err instanceof Anthropic.APIError ? `Anthropic ${String(err.status)}` : err instanceof GeminiError ? `Gemini ${err.kind}${err.status ? ` ${String(err.status)}` : ''}` : 'Not reached' }, used, s, started);
    return { route: 'failed' as const, voice, text: say(TEXT.failed, voice, { back: took(after) }), ai: after, suggestions };
  }
  const tools = answer.tools;
  if (answer.kind === 'answer') {
    const after = await settle(t, actor, held, { status: 'done', tools }, used, s, started);
    return { route: 'ai' as const, voice, text: answer.text, links: answer.links.map((href) => ({ label: say(TEXT.open, voice), href })), ai: after };
  }
  if (answer.kind === 'off_topic') {
    const after = await settle(t, actor, held, { status: 'done', route: 'off_topic', tools }, used, s, started);
    return { route: 'off_topic' as const, voice, text: say(TEXT.offTopic, voice, { back: took(after) }), ai: after, suggestions };
  }
  const why = answer.kind === 'too_big' ? 'Over the cap' : `Refused${answer.why ? ` (${answer.why})` : ''}`;
  const after = await settle(t, actor, held, { status: 'failed', error: why, tools }, used, s, started);
  return { route: 'failed' as const, voice, text: say(answer.kind === 'too_big' ? TEXT.tooBig : TEXT.failed, voice, { back: took(after) }), ai: after, suggestions };
}

/** Records the real cost and charges it (D109: the AI's work is paid even when the answer can't be used); exactly once. */
async function settle(t: TenantContext, actor: Actor, held: { id: Types.ObjectId; hold: Hold }, how: { status: 'done' | 'failed'; route?: 'off_topic'; error?: string; tools?: string[] }, used: Usage, s: AiSettings, started: number) {
  const cost = costOf(used, priceOf(s, s.chat.model), s.usdInr);
  spent.paise += cost;
  return inTransaction(async (session) => {
    const claimed = await AskQuestionModel.updateOne(
      { _id: held.id, status: 'running' },
      { $set: { status: how.status, ...(how.route ? { route: how.route } : {}), error: how.error, tools: how.tools, inputTokens: used.input, outputTokens: used.output, cacheReadTokens: used.cacheRead, cacheWriteTokens: used.cacheWrite, costPaise: cost, freeTier: onFreeTier(s, s.chat.model), ms: Date.now() - started } },
      { session },
    );
    if (!claimed.modifiedCount) return { coins: 0, freePaise: 0, balance: (await CoinWalletModel.findOne({ shopId: t.shopId }).session(session).lean())?.balance ?? 0 };
    const r = await settleJob(t.shopId, s, held.hold, cost, { kind: 'ask', text: 'AI question', byName: actor.name, ref: String(held.id) }, session);
    await AskQuestionModel.updateOne({ _id: held.id }, { $set: { coins: r.coins, freePaise: r.freePaise, refunded: r.coins === 0 && how.status === 'failed' } }, { session });
    return r;
  });
}

/** Questions left "running" by a restart give back what was set aside (scheduler); one before D109 its coin or free question. */
export async function settleStuckQuestions(now = new Date()) {
  const stuck = await AskQuestionModel.find({ status: 'running', createdAt: { $lt: new Date(now.getTime() - 10 * 60_000) } }).lean();
  const s = await aiSettings(now);
  for (const q of stuck) {
    await inTransaction(async (session) => {
      const claimed = await AskQuestionModel.updateOne({ _id: q._id, status: 'running' }, { $set: { status: 'failed', refunded: true, error: 'Stopped before it finished', coins: 0 } }, { session });
      if (!claimed.modifiedCount) return;
      if (q.hold) await settleJob(q.shopId, s, { coins: q.hold.coins ?? 0, freePaise: q.hold.freePaise ?? 0, month: q.hold.month ?? '', tokenPaise: q.hold.tokenPaise ?? null }, 0, { kind: 'ask', text: '', byName: 'MedBox24', ref: String(q._id) }, session);
      else if (q.free) await CoinWalletModel.updateOne({ shopId: q.shopId, askFree: { $gt: 0 } }, { $inc: { askFree: -1 } }, { session });
      else await moveCoins(q.shopId, 'refund', q.coins, 'Back: AI question — it stopped before it finished', 'MedBox24', String(q._id), session);
    });
  }
  return stuck.length;
}
