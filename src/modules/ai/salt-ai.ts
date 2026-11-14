import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../core/errors';
import { part } from '../../core/lang';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { GeminiError, generate, schemaFor, textOf, usageOf } from '../../services/gemini';
import { signal } from '../../services/monitor';
import { costOf, type Usage } from '../ask/ask-ai';
import { AskQuestionModel } from '../ask/ask.model';
import { spentThisMonth } from '../ask/ask.service';
import { sameSaltIn } from '../sales/same-salt';
import type { Actor } from '../user/actor';
import { aiSettings, apiKey, onFreeTier, priceOf, providerOf, readyFor, type AiSettings } from './ai-settings';
import { AI_MODELS, CoinWalletModel, SaltNoteModel } from './ai.model';
import { outOfCredit } from './credits';
import { AI_PAUSED, SALT_OUT, fits, safeNow, tokensFor, worstSalt } from './guard';
import { ensurePaise, freeLeft, type Hold, holdJob, quote, settleJob, shopAi, tookText } from './meter';

// D110: a medicine the shop has never kept — the AI says what it is made of, the shop's own stock gives the same salt.
// Asked only after a yes, paid by what it used (D109); the answer is kept for this shop, so the same name is free after.

export const findSaltSchema = z.object({ name: z.string().trim().min(3).max(60), confirm: z.boolean().optional() }).strict();
const aiSaltSchema = z.object({ known: z.boolean(), salt: z.string(), strength: z.string() });

const SYSTEM = `You help a pharmacy counter in India. You get a medicine's name as the staff typed it: a brand, maybe with its strength or form, maybe misspelt.
Reply with what it is made of:
- salt: the active ingredients' generic names as used in India, joined with " + ", e.g. "Paracetamol" or "Amoxycillin + Clavulanic Acid".
- strength: of each, in the same order, e.g. "650mg" or "500mg + 125mg" — the strength typed, else its most common one; "" when it has none.
- known: false when you are not sure which medicine sold in India this is, or the name could be different medicines; then salt and strength are "".
Never guess.`;

const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function askClaude(name: string, model: keyof typeof AI_MODELS, key: string) {
  const client = new Anthropic({ apiKey: key, baseURL: env.AI_BASE_URL, maxRetries: 1, timeout: 30_000 });
  const msg = await client.messages.create({
    model,
    max_tokens: SALT_OUT,
    system: SYSTEM,
    output_config: { ...(AI_MODELS[model].effort ? { effort: 'low' as const } : {}), format: { type: 'json_schema', schema: z.toJSONSchema(aiSaltSchema) } },
    messages: [{ role: 'user', content: name }],
  });
  const usage: Usage = { input: msg.usage.input_tokens, output: msg.usage.output_tokens, cacheRead: msg.usage.cache_read_input_tokens ?? 0, cacheWrite: msg.usage.cache_creation_input_tokens ?? 0 };
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return { usage, error: part('The AI answer could not be used') };
  const parsed = aiSaltSchema.safeParse(JSON.parse(msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('') || 'null'));
  return parsed.success ? { usage, salt: parsed.data } : { usage, error: part('The AI answer could not be used') };
}

async function askGemini(name: string, model: keyof typeof AI_MODELS, key: string) {
  const r = await generate(key, model, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: name }] }],
    generationConfig: { maxOutputTokens: SALT_OUT, responseMimeType: 'application/json', responseJsonSchema: schemaFor(z.toJSONSchema(aiSaltSchema)), thinkingConfig: { thinkingLevel: 'low' } },
  }, { timeoutMs: 30_000, retries: 1 });
  const u = usageOf(r);
  const usage: Usage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: 0 };
  const c = r.candidates?.[0];
  if (r.promptFeedback?.blockReason || !c || (c.finishReason && c.finishReason !== 'STOP')) return { usage, error: part('The AI answer could not be used') };
  try {
    const parsed = aiSaltSchema.safeParse(JSON.parse(textOf(c.content)));
    return parsed.success ? { usage, salt: parsed.data } : { usage, error: part('The AI answer could not be used') };
  } catch {
    return { usage, error: part('The AI answer could not be used') };
  }
}

/** What the counter is told: the medicine's salt and the shop's in-stock medicines with it. */
const shown = async (t: TenantContext, n: { name: string; known: boolean; salt: string; strength: string }) => ({ name: n.name, known: n.known, salt: n.salt, strength: n.strength, options: n.known ? await sameSaltIn(t, n.salt, n.strength) : [] });

export async function findSalt(t: TenantContext, actor: Actor, input: z.infer<typeof findSaltSchema>, now = new Date()) {
  const key = keyOf(input.name);
  if (key.length < 3) throw AppError.validation('Type at least 3 letters of the medicine');
  const note = await SaltNoteModel.findOne({ shopId: t.shopId, key }).lean();
  if (note) return { route: 'saved' as const, ...(await shown(t, note)) };

  const s = await aiSettings(now);
  const provider = providerOf(s.chat.model);
  const apiKeyOf = s.chat.enabled && readyFor(s, s.chat.model) ? await apiKey(provider) : null;
  if (!apiKeyOf) throw AppError.forbidden('AI is off');
  const worst = worstSalt(s);
  await ensurePaise(t.shopId);
  const w = await CoinWalletModel.findOne({ shopId: t.shopId }).lean();
  if (!input.confirm) {
    const mine = await shopAi(t.shopId, now);
    return { route: 'confirm' as const, need: quote(s, w, worst, now).coins, most: tokensFor(s, worst), free: mine.free, balance: mine.balance };
  }
  if ((await spentThisMonth(now)) >= s.chat.budgetUsd * s.usdInr * 100) {
    await signal('ask_budget', now);
    throw AppError.conflict('MedBox24’s AI for this month is used up — try again next month. No tokens were taken.', { reason: AI_PAUSED });
  }
  // Too few tokens is told by the hold below (buy tokens), not as a pause.
  if (!safeNow(s, 'chat') || ((w?.balance ?? 0) >= quote(s, w, worst, now).coins && !(await fits(t.shopId, s, worst, freeLeft(s, w, now))))) {
    await signal('ai_paused', now);
    throw AppError.conflict('AI is paused for your shop — MedBox24 has been told and will sort it out. No tokens were taken.', { reason: AI_PAUSED });
  }
  const held = await inTransaction(async (session) => {
    const hold = await holdJob(t.shopId, s, worst, session, now);
    const [doc] = await AskQuestionModel.create([{ shopId: t.shopId, shopName: t.shopName, userId: new Types.ObjectId(actor.id), userName: actor.name, route: 'ai', intent: 'salt', voice: 'en', status: 'running', coins: hold.coins, hold, model: s.chat.model }], { session });
    if (!doc) throw AppError.internal();
    return { id: doc._id, hold };
  });

  const started = Date.now();
  const settle = (status: 'done' | 'failed', used: Usage, error?: string) => settleSalt(t, actor, s, held, status, used, started, error);
  let answer: Awaited<ReturnType<typeof askClaude>>;
  try {
    answer = await (provider === 'google' ? askGemini : askClaude)(input.name, s.chat.model, apiKeyOf);
  } catch (err) {
    logger.warn({ err: err instanceof Anthropic.APIError ? { status: typeof err.status === 'number' ? err.status : null, type: err.name } : err instanceof GeminiError ? { status: err.status, type: err.kind } : String(err) }, 'AI salt lookup failed');
    await signal(outOfCredit(err) ? 'ai_credit_low' : 'ai_fail', now);
    const busy = err instanceof Anthropic.RateLimitError || (err instanceof GeminiError && err.kind === 'busy');
    const why = busy ? part('the AI is busy, try again in a minute') : part('the AI could not be reached');
    const r = await settle('failed', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'Not reached');
    throw new AppError(503, 'SERVICE_UNAVAILABLE', tookText(part(`Could not find the salt: ${why}`), r));
  }
  if ('error' in answer && answer.error) throw new AppError(422, 'VALIDATION_ERROR', tookText(answer.error, await settle('failed', answer.usage, 'Not usable')));
  const a = 'salt' in answer && answer.salt ? answer.salt : { known: false, salt: '', strength: '' };
  const known = a.known && a.salt.trim().length >= 3;
  const r = await settle('done', answer.usage);
  const kept = { name: input.name.trim(), known, salt: known ? a.salt.trim() : '', strength: known ? a.strength.trim() : '' };
  await SaltNoteModel.updateOne({ shopId: t.shopId, key }, { $set: { ...kept, byName: actor.name, model: s.chat.model } }, { upsert: true });
  return { route: 'ai' as const, ...(await shown(t, kept)), ai: r };
}

/** Records the real cost and charges it — the AI's work is paid even when it found nothing (D109); exactly once. */
async function settleSalt(t: TenantContext, actor: Actor, s: AiSettings, held: { id: Types.ObjectId; hold: Hold }, status: 'done' | 'failed', used: Usage, started: number, error?: string) {
  const cost = costOf(used, priceOf(s, s.chat.model), s.usdInr);
  return inTransaction(async (session) => {
    const claimed = await AskQuestionModel.updateOne(
      { _id: held.id, status: 'running' },
      { $set: { status, error, tools: ['find_salt'], inputTokens: used.input, outputTokens: used.output, cacheReadTokens: used.cacheRead, cacheWriteTokens: used.cacheWrite, costPaise: cost, freeTier: onFreeTier(s, s.chat.model), ms: Date.now() - started } },
      { session },
    );
    if (!claimed.modifiedCount) return { coins: 0, freePaise: 0, balance: (await CoinWalletModel.findOne({ shopId: t.shopId }).session(session).lean())?.balance ?? 0 };
    const r = await settleJob(t.shopId, s, held.hold, cost, { kind: 'ask', text: 'AI looked up a medicine’s salt', byName: actor.name, ref: String(held.id) }, session);
    await AskQuestionModel.updateOne({ _id: held.id }, { $set: { coins: r.coins, freePaise: r.freePaise, refunded: r.coins === 0 && status === 'failed' } }, { session });
    return r;
  });
}
