import { Types } from 'mongoose';
import { afterCursor, page, sortOf } from '../../core/cursor';
import type { AdminActor } from '../admin/admin-auth';
import { log } from '../admin/admin.service';
import { aiSettings, priceOf, saveChatSettings, savePrices, type ChatSettingsInput, type PricesInput } from '../ai/ai-settings';
import { CoinWalletModel } from '../ai/ai.model';
import { AskQuestionModel } from './ask.model';
import { forgetSpend } from './ask.service';

// D81 admin: is the price of a question safe against its worst cost, what the chat cost this month, and who used it.

const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;
const GST = 1.18;

export async function chatOverview(now = new Date()) {
  const ist = new Date(now.getTime() + IST);
  const m0 = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST);
  const month = { createdAt: { $gte: m0 } };
  const isAi = { $in: ['$route', ['ai', 'off_topic']] };
  const [s, routes, voices, last30, shops, shopsOn] = await Promise.all([
    aiSettings(),
    AskQuestionModel.aggregate<{ _id: string; n: number; cost: number; coins: number; free: number; tokensIn: number; tokensOut: number }>([
      { $match: month },
      { $group: { _id: '$route', n: { $sum: 1 }, cost: { $sum: '$costPaise' }, coins: { $sum: { $cond: ['$refunded', 0, '$coins'] } }, free: { $sum: { $cond: [{ $and: ['$free', { $not: ['$refunded'] }] }, 1, 0] } }, tokensIn: { $sum: { $add: ['$inputTokens', '$cacheReadTokens', '$cacheWriteTokens'] } }, tokensOut: { $sum: '$outputTokens' } } },
    ]),
    AskQuestionModel.aggregate<{ _id: string; n: number; ai: number; cost: number }>([{ $match: month }, { $group: { _id: '$voice', n: { $sum: 1 }, ai: { $sum: { $cond: [isAi, 1, 0] } }, cost: { $sum: '$costPaise' } } }, { $sort: { n: -1 } }]),
    AskQuestionModel.aggregate<{ n: number; cost: number }>([{ $match: { createdAt: { $gte: new Date(now.getTime() - 30 * DAY) }, route: { $in: ['ai', 'off_topic'] } } }, { $group: { _id: null, n: { $sum: 1 }, cost: { $sum: '$costPaise' } } }]),
    AskQuestionModel.aggregate<{ _id: Types.ObjectId; name: string; n: number; ai: number; cost: number; coins: number }>([
      { $match: month },
      { $group: { _id: '$shopId', name: { $first: '$shopName' }, n: { $sum: 1 }, ai: { $sum: { $cond: [isAi, 1, 0] } }, cost: { $sum: '$costPaise' }, coins: { $sum: { $cond: ['$refunded', 0, '$coins'] } } } },
      { $sort: { cost: -1, n: -1 } },
      { $limit: 10 },
    ]),
    CoinWalletModel.countDocuments({ askAi: true }).setOptions({ crossTenant: true }),
  ]);
  const on = new Set((await CoinWalletModel.find({ shopId: { $in: shops.map((x) => x._id) }, askAi: true }).select('shopId').lean()).map((w) => String(w.shopId)));

  const c = s.chat;
  const p = priceOf(s, c.model);
  // Worst case: every token of the caps, none from the cache.
  const worstPaise = Math.ceil(((c.capIn * p.input + c.capOut * p.output) * s.usdInr * 100) / 1_000_000);
  // A coin at the cheapest pack's price, GST taken out — the least a coin brings in.
  const coinPaise = Math.min(...s.packs.map((k) => Math.floor(k.price / GST / Math.max(1, k.coins))));
  const chargePaise = c.coinsPerQuestion * coinPaise;
  const avgPaise = last30[0]?.n ? Math.round(last30[0].cost / last30[0].n) : null;
  const ratio = (cost: number | null) => (cost ? Math.round((chargePaise / cost) * 10) / 10 : null);
  const suggest = Math.max(1, Math.ceil((c.margin * (avgPaise ?? worstPaise)) / Math.max(1, coinPaise)));

  const by = (r: string) => routes.find((x) => x._id === r);
  const sum = (k: 'n' | 'cost' | 'coins' | 'free' | 'tokensIn' | 'tokensOut') => routes.reduce((a, r) => a + r[k], 0);
  const free = by('free')?.n ?? 0;
  const unmatched = by('unmatched')?.n ?? 0;
  const costPaise = sum('cost');
  const coins = sum('coins');
  return {
    settings: c,
    model: { id: c.model, price: p },
    usdInr: s.usdInr,
    pricing: { worstPaise, coinPaise, chargePaise, avgPaise, worstRatio: ratio(worstPaise), avgRatio: ratio(avgPaise), suggestCoins: suggest, safe: chargePaise >= worstPaise },
    month: {
      questions: sum('n'),
      free,
      unmatched,
      ai: (by('ai')?.n ?? 0) + (by('off_topic')?.n ?? 0),
      offTopic: by('off_topic')?.n ?? 0,
      blocked: by('blocked')?.n ?? 0,
      freeShare: free + unmatched ? Math.round((free * 1000) / (free + unmatched)) / 10 : null,
      freeAiUsed: sum('free'),
      tokensIn: sum('tokensIn'),
      tokensOut: sum('tokensOut'),
      costPaise,
      coins,
      earnedPaise: coins * coinPaise,
      profitPaise: coins * coinPaise - costPaise,
      budgetPaise: Math.round(c.budgetUsd * s.usdInr * 100),
    },
    shopsOn,
    voices: voices.map((v) => ({ voice: v._id, questions: v.n, ai: v.ai, costPaise: v.cost })),
    shops: shops.map((x) => ({ shopId: String(x._id), shopName: x.name, aiOn: on.has(String(x._id)), questions: x.n, ai: x.ai, costPaise: x.cost, coins: x.coins })),
  };
}

/** Every chat question (never its text): shop, who, how it was answered, tokens, real cost. */
export async function chatQuestions(q: { shopId?: string; route?: string; cursor?: string; limit: number }) {
  const sort = { field: 'createdAt', dir: -1 } as const;
  const filter: Record<string, unknown> = {};
  if (q.shopId) filter.shopId = new Types.ObjectId(q.shopId);
  if (q.route) filter.route = q.route;
  const rows = await AskQuestionModel.find({ ...filter, ...afterCursor(q.cursor, sort) }).sort(sortOf(sort)).limit(q.limit + 1).lean();
  const { items, meta } = page(rows, q.limit, (r) => r.createdAt);
  return {
    items: items.map((r) => ({ id: String(r._id), shopId: String(r.shopId), shopName: r.shopName, userName: r.userName, route: r.route, intent: r.intent ?? null, tools: r.tools ?? [], voice: r.voice, status: r.status, free: r.free, coins: r.coins, refunded: r.refunded, error: r.error ?? null, model: r.model ?? null, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costPaise: r.costPaise, ms: r.ms ?? null, createdAt: r.createdAt })),
    meta,
  };
}

export async function updateChat(a: AdminActor, input: ChatSettingsInput, reason: string, ip?: string) {
  const before = (await aiSettings()).chat;
  const after = (await saveChatSettings(input, a.name)).chat;
  const changed = (Object.keys(input) as (keyof ChatSettingsInput)[]).filter((k) => before[k] !== after[k]);
  await log(a, 'ai_chat_settings', reason, `Shop chat: ${changed.join(', ') || 'no change'}${input.enabled !== before.enabled ? ` — turned ${input.enabled ? 'on' : 'off'}` : ''}`, undefined, { before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])) }, ip);
  forgetSpend();
  return chatOverview();
}

export async function updatePrices(a: AdminActor, input: PricesInput, reason: string, ip?: string) {
  const before = (await aiSettings()).prices;
  const after = (await savePrices(input, a.name)).prices;
  const changed = after.filter((p) => JSON.stringify(p) !== JSON.stringify(before.find((b) => b.model === p.model)));
  await log(a, 'ai_prices', reason, `AI prices: ${changed.map((p) => p.model).join(', ') || 'no change'}`, undefined, { before: before.filter((b) => changed.some((c) => c.model === b.model)), after: changed }, ip);
  return chatOverview();
}
