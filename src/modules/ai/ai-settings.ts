import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { open, seal } from '../../utils/totp';
import { AI_EFFORTS, AI_MODEL_IDS, AI_MODELS, AiSettingsModel, DEFAULT_PACKS } from './ai.model';

// Its own key from the admin secret, so a TOTP secret and the API key never share one.
const sealKey = () => `${env.ADMIN_TOTP_KEY ?? env.JWT_ACCESS_SECRET}|anthropic-api-key`;

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
    usdInr: z.number().min(50).max(200),
    packs: z.array(packSchema).min(1).max(6).refine((p) => new Set(p.map((x) => x.code)).size === p.length, 'Each pack needs its own code'),
  })
  .strict();
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;

export async function aiSettings() {
  const s = await AiSettingsModel.findById('ai').lean();
  return {
    enabled: s?.enabled ?? false,
    hasKey: Boolean(s?.keySealed),
    keyLast4: s?.keyLast4 ?? null,
    keySetAt: s?.keySetAt ?? null,
    keySetBy: s?.keySetBy ?? null,
    model: s?.model ?? 'claude-opus-5-5',
    effort: s?.effort ?? 'low',
    coinsPerPage: s?.coinsPerPage ?? 1,
    maxPages: s?.maxPages ?? 10,
    usdInr: s?.usdInr ?? 88,
    packs: (s?.packs?.length ? s.packs : DEFAULT_PACKS).map((p) => ({ code: p.code ?? '', name: p.name ?? '', coins: p.coins ?? 0, price: p.price ?? 0 })),
    models: AI_MODEL_IDS.map((id) => ({ id, ...AI_MODELS[id] })),
  };
}
export type AiSettings = Awaited<ReturnType<typeof aiSettings>>;

/** What the shop sees: on only when the admin turned it on and a key is set. */
export async function aiOffer() {
  const s = await aiSettings();
  return { enabled: s.enabled && s.hasKey, coinsPerPage: s.coinsPerPage, maxPages: s.maxPages, packs: s.packs };
}

export async function saveAiSettings(input: AiSettingsInput, by: string) {
  if (input.enabled && !(await AiSettingsModel.exists({ _id: 'ai', keySealed: { $type: 'string' } }))) throw AppError.validation('Set the Claude API key before turning AI reading on', [{ field: 'body.settings.enabled', message: 'No API key yet' }]);
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { ...input, updatedBy: by } }, { upsert: true });
  return aiSettings();
}

export async function setApiKey(key: string, by: string) {
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { keySealed: seal(key, sealKey()), keyLast4: key.slice(-4), keySetAt: new Date(), keySetBy: by } }, { upsert: true });
  return aiSettings();
}

/** Removing the key also turns AI reading off. */
export async function clearApiKey(by: string) {
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { enabled: false, updatedBy: by }, $unset: { keySealed: '', keyLast4: '', keySetAt: '', keySetBy: '' } }, { upsert: true });
  return aiSettings();
}

/** The plain key, only for the call to Anthropic. */
export async function apiKey(): Promise<string | null> {
  const s = await AiSettingsModel.findById('ai').select('keySealed').lean();
  return s?.keySealed ? open(s.keySealed, sealKey()) : null;
}
