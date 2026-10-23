import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { afterCursor, page, sortOf } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { inTransaction } from '../../core/transaction';
import type { AdminActor } from '../admin/admin-auth';
import { log } from '../admin/admin.service';
import { ShopModel } from '../shops/shop.model';
import { GeminiError, modelInfo } from '../../services/gemini';
import { PROVIDER_NAME, aiSettings, apiKey, clearApiKey, providerOf, saveAiSettings, setApiKey, setGeminiPaid, type AiSettingsInput } from './ai-settings';
import type { AiModelId, AiProvider } from './ai.model';
import { AiReadModel, CoinEntryModel, CoinOrderModel, CoinWalletModel } from './ai.model';
import { moveCoins } from './coins';
import { upcomingPrices } from './price-changes';
import { aiStatus, type Feature } from './status';
import { updateChat } from '../ask/ask-admin';

const DAY = 86_400_000;

/** The admin's AI page: settings (key as its last 4 only) and what reading has cost against what coins brought in. */
export async function aiOverview(now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const [settings, reads, month, sold, soldMonth, held] = await Promise.all([
    aiSettings(now),
    AiReadModel.aggregate<{ _id: string; n: number; pages: number; coins: number; cost: number }>([{ $group: { _id: '$status', n: { $sum: 1 }, pages: { $sum: '$pages' }, coins: { $sum: { $cond: ['$refunded', 0, '$coins'] } }, cost: { $sum: '$costPaise' } } }]),
    AiReadModel.aggregate<{ n: number; coins: number; cost: number }>([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: null, n: { $sum: 1 }, coins: { $sum: { $cond: ['$refunded', 0, '$coins'] } }, cost: { $sum: '$costPaise' } } }]),
    CoinOrderModel.aggregate<{ amount: number; gst: number; coins: number; n: number }>([{ $match: { status: 'paid' } }, { $group: { _id: null, amount: { $sum: '$amount' }, gst: { $sum: '$gst' }, coins: { $sum: '$coins' }, n: { $sum: 1 } } }]),
    CoinOrderModel.aggregate<{ amount: number; gst: number }>([{ $match: { status: 'paid', paidAt: { $gte: since } } }, { $group: { _id: null, amount: { $sum: '$amount' }, gst: { $sum: '$gst' } } }]),
    CoinWalletModel.aggregate<{ coins: number; shops: number }>([{ $match: { shopId: { $exists: true } } }, { $group: { _id: null, coins: { $sum: '$balance' }, shops: { $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] } } } }]),
  ]);
  const by = (s: string) => reads.find((r) => r._id === s);
  return {
    settings,
    reads: { done: by('done')?.n ?? 0, failed: by('failed')?.n ?? 0, pages: reads.reduce((a, r) => a + r.pages, 0), coins: reads.reduce((a, r) => a + r.coins, 0), costPaise: reads.reduce((a, r) => a + r.cost, 0) },
    month: { reads: month[0]?.n ?? 0, coins: month[0]?.coins ?? 0, costPaise: month[0]?.cost ?? 0, salesPaise: soldMonth[0]?.amount ?? 0, salesNetPaise: (soldMonth[0]?.amount ?? 0) - (soldMonth[0]?.gst ?? 0) },
    sold: { orders: sold[0]?.n ?? 0, coins: sold[0]?.coins ?? 0, amountPaise: sold[0]?.amount ?? 0, netPaise: (sold[0]?.amount ?? 0) - (sold[0]?.gst ?? 0) },
    held: { coins: held[0]?.coins ?? 0, shops: held[0]?.shops ?? 0 },
    status: await aiStatus(settings),
    priceChanges: upcomingPrices(settings, now),
  };
}

/** Every AI read: shop, who, which file, pages, coins, Anthropic's real cost. */
export async function aiReads(q: { shopId?: string; status?: string; cursor?: string; limit: number }) {
  const sort = { field: 'createdAt', dir: -1 } as const;
  const filter: Record<string, unknown> = {};
  if (q.shopId) filter.shopId = new Types.ObjectId(q.shopId);
  if (q.status) filter.status = q.status;
  const rows = await AiReadModel.find({ ...filter, ...afterCursor(q.cursor, sort) }).sort(sortOf(sort)).limit(q.limit + 1).lean();
  const { items, meta } = page(rows, q.limit, (r) => r.createdAt);
  return {
    items: items.map((r) => ({ id: String(r._id), shopId: String(r.shopId), shopName: r.shopName, userName: r.userName, supplierName: r.supplierName, fileName: r.fileName, fileType: r.fileType, pages: r.pages, coins: r.coins, model: r.model, status: r.status, refunded: r.refunded, error: r.error ?? null, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costPaise: r.costPaise, lines: r.lines, ms: r.ms ?? null, createdAt: r.createdAt })),
    meta,
  };
}

export async function coinOrders(q: { cursor?: string; limit: number }) {
  const sort = { field: 'createdAt', dir: -1 } as const;
  const rows = await CoinOrderModel.find({ status: { $in: ['paid', 'failed'] }, ...afterCursor(q.cursor, sort) }).sort(sortOf(sort)).limit(q.limit + 1).lean();
  const { items, meta } = page(rows, q.limit, (r) => r.createdAt);
  const names = new Map((await ShopModel.find({ _id: { $in: items.map((o) => o.shopId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  return { items: items.map((o) => ({ id: String(o._id), shopId: String(o.shopId), shopName: names.get(String(o.shopId)) ?? '', packName: o.packName, coins: o.coins, amount: o.amount, gst: o.gst, status: o.status, invoiceNumber: o.invoiceNumber ?? null, source: o.source, paymentId: o.razorpayPaymentId ?? null, paidAt: o.paidAt ?? null, createdAt: o.createdAt, failureReason: o.failureReason ?? null, byName: o.createdByName })), meta };
}

/** A shop's coins for the admin shop page. */
export async function shopCoins(shopId: string) {
  const id = new Types.ObjectId(shopId);
  const [w, entries] = await Promise.all([CoinWalletModel.findOne({ shopId: id }).lean(), CoinEntryModel.find({ shopId: id }).sort({ createdAt: -1, _id: -1 }).limit(30).lean()]);
  return { balance: w?.balance ?? 0, entries: entries.map((e) => ({ id: String(e._id), kind: e.kind, coins: e.coins, balance: e.balance, text: e.text, byName: e.byName, at: e.createdAt })) };
}

/** Coins given (or taken back) by hand — accounts / super, with a reason, in both audit logs. */
export async function grantCoins(a: AdminActor, shopId: string, coins: number, reason: string, ip?: string) {
  const shop = await ShopModel.findById(shopId).select('name').lean();
  if (!shop) throw AppError.notFound('Shop not found');
  const text = coins > 0 ? `gave ${String(coins)} AI tokens` : `took back ${String(-coins)} AI tokens`;
  const balance = await inTransaction((session) => moveCoins(shop._id, 'grant', coins, `MedBox24 ${coins > 0 ? 'added' : 'took back'} ${String(Math.abs(coins))} tokens — ${reason}`, `MedBox24 · ${a.name}`, `admin:${a.id}`, session));
  await log(a, 'coins', reason, `${text} — balance ${String(balance)}`, { id: shop._id, name: shop.name }, undefined, ip);
  return { balance };
}

export async function updateAiSettings(a: AdminActor, input: AiSettingsInput, reason: string, ip?: string) {
  const before = await aiSettings();
  const after = await saveAiSettings(input, a.name);
  const changed = (Object.keys(input) as (keyof AiSettingsInput)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  await log(a, 'ai_settings', reason, `AI reading: ${changed.join(', ') || 'no change'}${input.enabled !== before.enabled ? ` — turned ${input.enabled ? 'on' : 'off'}` : ''}`, undefined, { before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])) }, ip);
  return after;
}

/** The status card's one tap: a feature on or off, with the model or coins that let it run — through the same checks and log as the full form. */
export async function switchAi(a: AdminActor, b: { feature: Feature; on: boolean; model?: AiModelId; coins?: number }, reason: string, ip?: string) {
  const s = await aiSettings();
  if (b.feature === 'read') await updateAiSettings(a, { enabled: b.on, model: b.model ?? s.model, effort: s.effort, coinsPerPage: b.coins ?? s.coinsPerPage, maxPages: s.maxPages, welcomeCoins: s.welcomeCoins, targetMargin: s.targetMargin, usdInr: s.usdInr, packs: s.packs }, reason, ip);
  else await updateChat(a, { ...s.chat, enabled: b.on, model: b.model ?? s.chat.model, coinsPerQuestion: b.coins ?? s.chat.coinsPerQuestion }, reason, ip);
  return aiOverview();
}

export async function updateGeminiBilling(a: AdminActor, paid: boolean, reason: string, ip?: string) {
  const before = await aiSettings();
  const s = await setGeminiPaid(paid, a.name);
  await log(a, 'ai_key_billing', reason, `Gemini key: billing ${paid ? 'on' : 'off (free tier)'}${before.chat.enabled && !s.chat.enabled ? ' — the chat off' : ''}`, undefined, undefined, ip);
  return aiOverview();
}

export async function updateApiKey(a: AdminActor, key: string | null, reason: string, ip?: string, p: AiProvider = 'anthropic', paid = false) {
  const before = await aiSettings();
  const s = key ? await setApiKey(key, a.name, p, paid) : await clearApiKey(a.name, p);
  const off = [before.enabled && !s.enabled ? 'AI reading' : '', before.chat.enabled && !s.chat.enabled ? 'the chat' : ''].filter(Boolean).join(' and ');
  await log(a, key ? 'ai_key_set' : 'ai_key_removed', reason, key ? `set the ${PROVIDER_NAME[p]} API key (…${key.slice(-4)})${p === 'google' ? (paid ? ', billing on' : ', free tier') : ''}${off ? ` — ${off} off` : ''}` : `removed the ${PROVIDER_NAME[p]} API key${off ? ` — ${off} off` : ''}`, undefined, undefined, ip);
  return s;
}

/** A Gemini key is tried on the model a feature already uses, else the newest Flash. */
async function testGeminiKey(s: Awaited<ReturnType<typeof aiSettings>>) {
  const key = await apiKey('google');
  if (!key) throw AppError.validation('No Gemini API key yet');
  const model: AiModelId = [s.model, s.chat.model].find((m) => providerOf(m) === 'google') ?? 'gemini-3.8-flash';
  try {
    const m = await modelInfo(key, model);
    return { ok: true, model, message: `The key works — ${m.displayName ?? model} answered` };
  } catch (err) {
    const kind = err instanceof GeminiError ? err.kind : 'down';
    const message = kind === 'refused' ? 'Google refused this key' : kind === 'missing' ? `This key cannot use ${model}` : kind === 'busy' ? 'Google says the key is over its limit — try again later' : 'Google could not be reached';
    return { ok: false, model, message };
  }
}

/** One small call with the saved key: is it accepted, and can it use the chosen model? */
export async function testApiKey(p: AiProvider = 'anthropic') {
  if (p === 'google') return testGeminiKey(await aiSettings());
  const [key, s] = await Promise.all([apiKey(), aiSettings()]);
  if (!key) throw AppError.validation('No API key yet');
  const model: AiModelId = [s.model, s.chat.model].find((m) => providerOf(m) === 'anthropic') ?? 'claude-haiku-5-5';
  try {
    const m = await new Anthropic({ apiKey: key, baseURL: env.AI_BASE_URL, maxRetries: 0, timeout: 20_000 }).models.retrieve(model);
    return { ok: true, model: m.id, message: `The key works — ${m.display_name} answered` };
  } catch (err) {
    const message = err instanceof Anthropic.AuthenticationError ? 'Anthropic refused this key' : err instanceof Anthropic.NotFoundError ? `This key cannot use ${model}` : err instanceof Anthropic.APIError ? `Anthropic said ${String(err.status)}` : 'Anthropic could not be reached';
    return { ok: false, model, message };
  }
}

