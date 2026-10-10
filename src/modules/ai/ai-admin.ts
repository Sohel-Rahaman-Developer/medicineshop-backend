import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { afterCursor, page, sortOf } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { inTransaction } from '../../core/transaction';
import type { AdminActor } from '../admin/admin-auth';
import { log } from '../admin/admin.service';
import { ShopModel } from '../shops/shop.model';
import { aiSettings, apiKey, clearApiKey, saveAiSettings, setApiKey, type AiSettingsInput } from './ai-settings';
import { AiReadModel, CoinEntryModel, CoinOrderModel, CoinWalletModel } from './ai.model';
import { moveCoins } from './coins';

const DAY = 86_400_000;

/** The admin's AI page: settings (key as its last 4 only) and what reading has cost against what coins brought in. */
export async function aiOverview(now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const [settings, reads, month, sold, soldMonth, held] = await Promise.all([
    aiSettings(),
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
  const text = coins > 0 ? `gave ${String(coins)} AI coins` : `took back ${String(-coins)} AI coins`;
  const balance = await inTransaction((session) => moveCoins(shop._id, 'grant', coins, `MedBox24 ${coins > 0 ? 'added' : 'took back'} ${String(Math.abs(coins))} coins — ${reason}`, `MedBox24 · ${a.name}`, `admin:${a.id}`, session));
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

export async function updateApiKey(a: AdminActor, key: string | null, reason: string, ip?: string) {
  const s = key ? await setApiKey(key, a.name) : await clearApiKey(a.name);
  await log(a, key ? 'ai_key_set' : 'ai_key_removed', reason, key ? `set the Claude API key (…${key.slice(-4)})` : 'removed the Claude API key — AI reading off', undefined, undefined, ip);
  return s;
}

/** One small call with the saved key: is it accepted, and can it use the chosen model? */
export async function testApiKey() {
  const [key, s] = await Promise.all([apiKey(), aiSettings()]);
  if (!key) throw AppError.validation('No API key yet');
  try {
    const m = await new Anthropic({ apiKey: key, baseURL: env.AI_BASE_URL, maxRetries: 0, timeout: 20_000 }).models.retrieve(s.model);
    return { ok: true, model: m.id, message: `The key works — ${m.display_name} answered` };
  } catch (err) {
    const message = err instanceof Anthropic.AuthenticationError ? 'Anthropic refused this key' : err instanceof Anthropic.NotFoundError ? `This key cannot use ${s.model}` : err instanceof Anthropic.APIError ? `Anthropic said ${String(err.status)}` : 'Anthropic could not be reached';
    return { ok: false, model: s.model, message };
  }
}

