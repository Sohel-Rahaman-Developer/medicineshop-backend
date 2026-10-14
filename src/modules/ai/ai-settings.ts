import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { open, seal } from '../../utils/totp';
import { assertNoLoss, safeNow } from './guard';
import { AI_EFFORTS, AI_MODEL_IDS, AI_MODELS, AiSettingsModel, DEFAULT_PACKS, type AiModelId, type AiProvider } from './ai.model';

// Its own key from the admin secret, so a TOTP secret and an API key never share one.
const sealKey = (p: AiProvider) => `${env.ADMIN_TOTP_KEY ?? env.JWT_ACCESS_SECRET}|${p === 'anthropic' ? 'anthropic' : 'gemini'}-api-key`;
export const PROVIDER_NAME: Record<AiProvider, string> = { anthropic: 'Claude', google: 'Gemini' };
export const providerOf = (model: AiModelId): AiProvider => AI_MODELS[model].provider;

export const packSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9-]{1,19}$/, 'Code: small letters and digits'),
    name: z.string().trim().min(2).max(30),
    coins: z.number().int().min(1).max(100_000),
    price: z.number().int().min(100).max(10_000_000),
  })
  .strict();

export const aiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    model: z.enum(AI_MODEL_IDS),
    effort: z.enum(AI_EFFORTS),
    coinsPerPage: z.number().int().min(1).max(100),
    maxPages: z.number().int().min(1).max(20),
    welcomeCoins: z.number().int().min(0).max(1000),
    targetMargin: z.number().min(1).max(20),
    usdInr: z.number().min(50).max(200),
    packs: z.array(packSchema).min(1).max(6).refine((p) => new Set(p.map((x) => x.code)).size === p.length, 'Each pack needs its own code'),
  })
  .strict();
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;

const usd = z.number().min(0).max(1000);
export const pricesSchema = z
  .array(z.object({ model: z.enum(AI_MODEL_IDS), input: usd, output: usd, cacheRead: usd, cacheWrite: usd }).strict())
  .max(AI_MODEL_IDS.length)
  .refine((p) => new Set(p.map((x) => x.model)).size === p.length, 'One price per model');
export type PricesInput = z.infer<typeof pricesSchema>;

export const chatSettingsSchema = z
  .object({
    enabled: z.boolean(),
    model: z.enum(AI_MODEL_IDS),
    coinsPerQuestion: z.number().int().min(1).max(20),
    capIn: z.number().int().min(6000).max(100_000),
    capOut: z.number().int().min(200).max(4000),
    perShopDay: z.number().int().min(1).max(1000),
    budgetUsd: z.number().min(1).max(100_000),
  })
  .strict();
export type ChatSettingsInput = z.infer<typeof chatSettingsSchema>;

export const CHAT_DEFAULTS: ChatSettingsInput = { enabled: false, model: 'claude-haiku-5-5', coinsPerQuestion: 1, capIn: 8000, capOut: 500, perShopDay: 30, budgetUsd: 50 };

/** List price unless the admin set one; cache reads at a tenth, cache writes at 1.25× input (Anthropic's rule; Gemini never writes). */
export interface Price {
  model: AiModelId;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export function listPrice(model: AiModelId): Price {
  const m = AI_MODELS[model];
  return { model, input: m.input, output: m.output, cacheRead: m.input / 10, cacheWrite: m.input * 1.25 };
}

export async function aiSettings() {
  const s = await AiSettingsModel.findById('ai').lean();
  return {
    enabled: s?.enabled ?? false,
    hasKey: Boolean(s?.keySealed),
    keyLast4: s?.keyLast4 ?? null,
    keySetAt: s?.keySetAt ?? null,
    keySetBy: s?.keySetBy ?? null,
    gemini: { hasKey: Boolean(s?.gemini?.keySealed), keyLast4: s?.gemini?.keyLast4 ?? null, keySetAt: s?.gemini?.keySetAt ?? null, keySetBy: s?.gemini?.keySetBy ?? null, paid: Boolean(s?.gemini?.paid) },
    model: s?.model ?? 'claude-opus-5-5',
    effort: s?.effort ?? 'low',
    coinsPerPage: s?.coinsPerPage ?? 1,
    maxPages: s?.maxPages ?? 10,
    welcomeCoins: s?.welcomeCoins ?? 100,
    targetMargin: s?.targetMargin ?? 1.5,
    usdInr: s?.usdInr ?? 88,
    packs: (s?.packs?.length ? s.packs : DEFAULT_PACKS).map((p) => ({ code: p.code ?? '', name: p.name ?? '', coins: p.coins ?? 0, price: p.price ?? 0 })),
    models: AI_MODEL_IDS.map((id) => ({ id, ...AI_MODELS[id] })),
    prices: AI_MODEL_IDS.map((id) => {
      const p = s?.prices?.find((x) => x.model === id);
      return p ? { model: id, input: p.input ?? 0, output: p.output ?? 0, cacheRead: p.cacheRead ?? 0, cacheWrite: p.cacheWrite ?? 0 } : listPrice(id);
    }),
    chat: chatOf(stripNull(s?.chat)),
  };
}

/** Only the fields the chat has now — an older stored one (its own margin) is left behind. */
const chatOf = (c: Partial<ChatSettingsInput>): ChatSettingsInput => Object.fromEntries(Object.entries(CHAT_DEFAULTS).map(([k, v]) => [k, (c as Record<string, unknown>)[k] ?? v])) as ChatSettingsInput;

const stripNull = (o: object | null | undefined): Record<string, unknown> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== null && v !== undefined));

/** A model can run only when its provider's key is set. */
export const readyFor = (s: { hasKey: boolean; gemini: { hasKey: boolean } }, model: AiModelId) => (providerOf(model) === 'anthropic' ? s.hasKey : s.gemini.hasKey);

export const priceOf = (s: { prices: Price[] }, model: AiModelId): Price => s.prices.find((p) => p.model === model) ?? listPrice(model);
export type AiSettings = Awaited<ReturnType<typeof aiSettings>>;

/** What the shop sees: on only when the admin turned it on and a key is set. */
export async function aiOffer() {
  const s = await aiSettings();
  return { enabled: s.enabled && readyFor(s, s.model) && safeNow(s, 'read'), coinsPerPage: s.coinsPerPage, maxPages: s.maxPages, packs: s.packs };
}

const needKey = (s: AiSettings, model: AiModelId, what: string, field: string) => {
  if (!readyFor(s, model)) throw AppError.validation(`Set the ${PROVIDER_NAME[providerOf(model)]} API key before turning ${what} on`, [{ field, message: 'No API key yet' }]);
};

export async function saveAiSettings(input: AiSettingsInput, by: string) {
  const s = await aiSettings();
  if (input.enabled) needKey(s, input.model, 'AI reading', 'body.settings.enabled');
  assertNoLoss({ ...s, ...input }, 'body.settings');
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { ...input, updatedBy: by } }, { upsert: true });
  return aiSettings();
}

export async function savePrices(input: PricesInput, by: string) {
  const s = await aiSettings();
  assertNoLoss({ ...s, prices: AI_MODEL_IDS.map((id) => input.find((p) => p.model === id) ?? listPrice(id)) }, 'body.prices');
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { prices: input, updatedBy: by } }, { upsert: true });
  return aiSettings();
}

/** On Google's free tier what is sent may be used by Google; chat questions carry customers' names, so the chat needs the paid tier. */
export const FREE_TIER_CHAT = 'Turn on billing for the Gemini key first — on the free tier Google may use what is sent, and chat questions carry customers’ names';

export async function saveChatSettings(input: ChatSettingsInput, by: string) {
  const s = await aiSettings();
  if (input.enabled) needKey(s, input.model, 'the chat', 'body.chat.enabled');
  if (input.enabled && providerOf(input.model) === 'google' && !s.gemini.paid) throw AppError.validation(FREE_TIER_CHAT, [{ field: 'body.chat.model', message: 'Gemini key on the free tier' }]);
  assertNoLoss({ ...s, chat: input }, 'body.chat');
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { chat: input, updatedBy: by } }, { upsert: true });
  return aiSettings();
}

const prefix = (p: AiProvider) => (p === 'anthropic' ? '' : 'gemini.');

/** paid: the admin says billing is on for a Gemini key; a free-tier key stops a chat running on Gemini. */
export async function setApiKey(key: string, by: string, p: AiProvider = 'anthropic', paid = false) {
  const f = prefix(p);
  const s = await aiSettings();
  const chatOff = p === 'google' && !paid && providerOf(s.chat.model) === 'google' ? { 'chat.enabled': false } : {};
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { [`${f}keySealed`]: seal(key, sealKey(p)), [`${f}keyLast4`]: key.slice(-4), [`${f}keySetAt`]: new Date(), [`${f}keySetBy`]: by, ...(p === 'google' ? { 'gemini.paid': paid } : {}), ...chatOff } }, { upsert: true });
  return aiSettings();
}

/** Billing on or off for the Gemini key without pasting it again; off stops a chat running on Gemini. */
export async function setGeminiPaid(paid: boolean, by: string) {
  const s = await aiSettings();
  if (!s.gemini.hasKey) throw AppError.validation('Set the Gemini key first', [{ field: 'body.paid', message: 'No Gemini key' }]);
  const chatOff = !paid && providerOf(s.chat.model) === 'google' ? { 'chat.enabled': false } : {};
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { 'gemini.paid': paid, updatedBy: by, ...chatOff } });
  return aiSettings();
}

/** Removing a key also turns off whatever runs on that provider's model — bill reading, the chat or both. */
export async function clearApiKey(by: string, p: AiProvider = 'anthropic') {
  const s = await aiSettings();
  const f = prefix(p);
  const off = { ...(providerOf(s.model) === p ? { enabled: false } : {}), ...(providerOf(s.chat.model) === p ? { 'chat.enabled': false } : {}) };
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { ...off, updatedBy: by }, $unset: { [`${f}keySealed`]: '', [`${f}keyLast4`]: '', [`${f}keySetAt`]: '', [`${f}keySetBy`]: '', ...(p === 'google' ? { 'gemini.paid': '' } : {}) } }, { upsert: true });
  return aiSettings();
}

/** The plain key, only for the call to the provider. */
export async function apiKey(p: AiProvider = 'anthropic'): Promise<string | null> {
  const s = await AiSettingsModel.findById('ai').select('keySealed gemini').lean();
  const sealed = p === 'anthropic' ? s?.keySealed : s?.gemini?.keySealed;
  return sealed ? open(sealed, sealKey(p)) : null;
}
