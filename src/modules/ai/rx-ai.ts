import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import sharp from 'sharp';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { DoseFreq } from '../../content/dose-words';
import { AppError } from '../../core/errors';
import { part } from '../../core/lang';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { GeminiError, generate, schemaFor, textOf, usageOf } from '../../services/gemini';
import { signal } from '../../services/monitor';
import { unitWords } from '../../utils/units';
import { ProductModel } from '../products/product.model';
import { DOSE_PATTERN, type Dose } from '../sales/sale.dose';
import { posSearch } from '../sales/sales.service';
import type { Actor } from '../user/actor';
import { aiSettings, apiKey, onFreeTier, priceOf, providerOf } from './ai-settings';
import { AI_MODELS, AiReadModel } from './ai.model';
import { costPaise } from './bill-ai';
import { balanceOf, moveCoins } from './coins';
import { outOfCredit } from './credits';
import { AI_PAUSED, PAGE_OUT, fits, safeNow, worstPage } from './guard';

export const rxReadSchema = z.object({ photo: z.string().min(8).max(6_000_000, 'That photo is too large — at most about 4 MB') }).strict();

// What is written, as written — the shop's software finds the medicines and works out quantities, not the model.
const itemSchema = z.object({
  written: z.string(),
  form: z.string(),
  name: z.string(),
  strength: z.string(),
  salt: z.string(),
  freq: z.string(),
  meal: z.string(),
  days: z.string(),
  quantity: z.string(),
  clear: z.boolean(),
});
export const aiRxSchema = z.object({ prescription: z.boolean(), doctor: z.string(), patient: z.string(), items: z.array(itemSchema) });
export type AiRx = z.infer<typeof aiRxSchema>;
type AiRxItem = AiRx['items'][number];

const SYSTEM = `You read a doctor's prescription from India, often handwritten, for a pharmacy counter, into JSON.
Copy only what is written. Never guess a medicine you cannot read, never add one, never change a strength.
For each medicine line, in order:
- written: the whole line as written, e.g. "Tab Augmentin 625 1-0-1 x 5d PC".
- form: Tab, Cap, Syp, Inj, Inf, E/D, Oint, Cream, Drops… as written, or "".
- name: the medicine's name only (brand or generic), without the form and the strength.
- strength: as written, e.g. "625", "500 mg"; "" if none.
- salt: the generic name or composition only when it is written on the prescription; else "".
- freq: how often, as written: OD, BD, TDS, QDS, HS, OD HS, SOS, Stat, or a pattern like 1-0-1 or 1/2-0-1/2; "" if none.
- meal: "AC" for before food, "PC" for after food; "" if not written.
- days: the number of days if written (x 5d, 5/7, 5 days), as digits; "" if none.
- quantity: the total quantity if written (e.g. "10", "1 strip", "1 bottle"); "" if none.
- clear: false when any part of the line is hard to read or you are not sure of the medicine's name or strength.
doctor and patient: their names as written; "" when not written.
prescription: false when the picture is not a prescription; then return no items.`;

const FREQ: Record<string, DoseFreq> = { OD: 'OD', QD: 'OD', BD: 'BD', BID: 'BD', TDS: 'TDS', TID: 'TDS', QDS: 'QDS', QID: 'QDS', HS: 'HS', 'OD HS': 'HS', SOS: 'SOS', PRN: 'SOS', STAT: 'STAT' };

/** The prescription's "BD, PC, x 5d" as the counter's dose box; null when nothing usable is written. */
export function doseOf(it: Pick<AiRxItem, 'freq' | 'meal' | 'days'>): Dose | null {
  const f = it.freq.toUpperCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  const halves = it.freq.replace(/\s+/g, '').replace(/11\/2|1\.5/g, '1½').replace(/1\/2|0\.5/g, '½');
  const freq = FREQ[f] ?? null;
  const pattern = !freq && DOSE_PATTERN.test(halves) ? halves : null;
  const m = it.meal.toUpperCase().replace(/[.\s]/g, '');
  const meal = m.startsWith('AC') || m.startsWith('BEFORE') ? 'AC' : m.startsWith('PC') || m.startsWith('AFTER') ? 'PC' : null;
  const n = Number(/\d+/.exec(it.days)?.[0] ?? NaN);
  const days = Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
  return freq || pattern || meal || days ? { freq, pattern, meal, days } : null;
}

const SLOT: Record<string, number> = { '0': 0, '½': 0.5, '1': 1, '1½': 1.5, '2': 2, '3': 3 };
const PER_DAY: Partial<Record<DoseFreq, number>> = { OD: 1, BD: 2, TDS: 3, QDS: 4, HS: 1 };

/** Doses a day: OD 1 … QDS 4, a 1-0-1 pattern its sum; null for SOS / Stat or nothing written. */
export function perDay(d: Dose | null): number | null {
  if (!d) return null;
  if (d.pattern) return d.pattern.split('-').reduce((s, v) => s + (SLOT[v] ?? 0), 0) || null;
  return d.freq ? (PER_DAY[d.freq] ?? null) : null;
}

type HitUnits = { base: string; sale: string; salePack: number; allowLooseSale: boolean };
const COUNTED = new Set(['TABLET', 'CAPSULE']);

/** How much to put on the bill, and why — the working shown to the pharmacist, never hidden. */
export function suggestQty(u: HitUnits, d: Dose | null, written: string, sellable: number): { qtyBase: number; why: string } {
  const pack = Math.max(1, u.salePack);
  const whole = (n: number) => (u.allowLooseSale || pack === 1 ? n : Math.ceil(n / pack) * pack);
  let qty = pack;
  let why = `${unitWords(1, u.sale)} — no days on the prescription`;
  const day = perDay(d);
  const n = /^\s*(\d{1,4})\s*$/.exec(written)?.[1];
  if (COUNTED.has(u.base) && day && d?.days) {
    const need = Math.ceil(day * d.days);
    qty = whole(need);
    why = `${d.pattern ?? (d.freq === 'STAT' ? 'Stat' : d.freq)} = ${String(day)} a day × ${unitWords(d.days, 'day')} = ${unitWords(need, u.base)}${qty !== need ? ` → ${unitWords(qty / pack, u.sale)}` : ''}`;
  } else if (COUNTED.has(u.base) && n) {
    qty = whole(Number(n));
    why = `${unitWords(Number(n), u.base)} written on the prescription`;
  } else if (!COUNTED.has(u.base)) {
    why = unitWords(1, u.sale);
  }
  if (qty > sellable) {
    qty = u.allowLooseSale || pack === 1 ? sellable : Math.floor(sellable / pack) * pack;
    why += ` · only ${unitWords(sellable, u.base)} in stock`;
  }
  return { qtyBase: qty, why };
}

type Hit = Awaited<ReturnType<typeof posSearch>>['items'][number];
const digits = (s: string): string[] => (s.match(/\d[\d.]*/g) ?? []).map((n) => n.replace(/\.+$/, ''));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
/** A different strength is a different medicine: 625 must not become 375. */
const strengthFits = (h: Hit, it: Pick<AiRxItem, 'strength'>) => digits(it.strength).every((w) => digits(`${h.name} ${h.salt}`).includes(w));
/** Every word of the written name is a word of the product's name — "Pan" is not "Pantocid" (another brand). */
const nameFits = (h: Hit, it: Pick<AiRxItem, 'name'>) => words(it.name).every((w) => words(h.name).includes(w));

export type RxStatus = 'add' | 'missing' | 'check';
export interface RxLine {
  written: string;
  name: string;
  status: RxStatus;
  clear: boolean;
  dose: Dose | null;
  hit: Hit | null;
  qtyBase: number;
  why: string;
  /** To pick from: the possible matches (check) or same-salt medicines in stock (missing). */
  options: Hit[];
}

/** In-stock medicines with the same salt (and strength), the out-of-stock one left out. */
async function sameSalt(t: TenantContext, salt: string, not: string | null): Promise<Hit[]> {
  const key = salt.toLowerCase().replace(/\s+/g, ' ').trim();
  if (key.length < 3) return [];
  const rows = await ProductModel.find({ shopId: t.shopId, isActive: true, 'stock.sellable': { $gt: 0 } }).select('salt strength').limit(500).lean();
  const ids = rows.filter((p) => String(p._id) !== not && [p.salt, p.strength].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim() === key).map((p) => String(p._id));
  return ids.length ? (await posSearch(t, '', 50, ids.slice(0, 6))).items : [];
}

/** One written line → a medicine on the shelf, a gap with its same-salt options, or a doubt for the pharmacist. */
export async function matchLine(t: TenantContext, it: AiRxItem): Promise<RxLine> {
  const dose = doseOf(it);
  const base = { written: it.written, name: [it.form, it.name, it.strength].filter(Boolean).join(' '), clear: it.clear, dose, hit: null, qtyBase: 0, why: '', options: [] as Hit[] };
  const q = words(it.name).join(' ');
  const found = q ? (await posSearch(t, q, 12)).items : [];
  const hits = found.filter((h) => nameFits(h, it) && strengthFits(h, it));
  const inStock = hits.filter((h) => h.sellable > 0);
  const one = inStock.length === 1 ? inStock[0] : undefined;
  if (it.clear && one) return { ...base, status: 'add', hit: one, ...suggestQty(one.units, dose, it.quantity, one.sellable) };
  if (inStock.length) return { ...base, status: 'check', options: inStock.slice(0, 4) };
  const known = hits[0];
  const options = await sameSalt(t, known?.salt || it.salt, known?.id ?? null);
  return { ...base, status: it.clear ? 'missing' : 'check', options: options.filter((h) => strengthFits(h, it)).slice(0, 4) };
}

async function askClaude(photo: Buffer, s: { model: keyof typeof AI_MODELS; effort: 'low' | 'medium' | 'high' }, key: string) {
  const client = new Anthropic({ apiKey: key, baseURL: env.AI_BASE_URL, maxRetries: 2, timeout: 2 * 60_000 });
  const stream = client.messages.stream({
    model: s.model,
    max_tokens: PAGE_OUT,
    system: SYSTEM,
    output_config: { ...(AI_MODELS[s.model].effort ? { effort: s.effort } : {}), format: { type: 'json_schema', schema: z.toJSONSchema(aiRxSchema) } },
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo.toString('base64') } }, { type: 'text', text: 'Read this prescription into the JSON.' }] }],
  });
  const msg = await stream.finalMessage();
  const usage = { input: msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0), output: msg.usage.output_tokens };
  if (msg.stop_reason === 'refusal') return { usage, error: part('The AI would not read this photo') };
  if (msg.stop_reason === 'max_tokens') return { usage, error: part('The AI answer could not be used') };
  try {
    return { usage, rx: aiRxSchema.parse(JSON.parse(msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))) };
  } catch {
    return { usage, error: part('The AI answer could not be used') };
  }
}

async function askGemini(photo: Buffer, s: { model: keyof typeof AI_MODELS; effort: 'low' | 'medium' | 'high' }, key: string) {
  const r = await generate(key, s.model, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: photo.toString('base64') } }, { text: 'Read this prescription into the JSON.' }] }],
    generationConfig: { maxOutputTokens: PAGE_OUT, responseMimeType: 'application/json', responseJsonSchema: schemaFor(z.toJSONSchema(aiRxSchema)), thinkingConfig: { thinkingLevel: s.effort } },
  }, { timeoutMs: 2 * 60_000, retries: 2 });
  const u = usageOf(r);
  const usage = { input: u.input + u.cacheRead, output: u.output };
  const c = r.candidates?.[0];
  if (r.promptFeedback?.blockReason || !c || (c.finishReason && c.finishReason !== 'STOP')) return { usage, error: part('The AI would not read this photo') };
  try {
    return { usage, rx: aiRxSchema.parse(JSON.parse(textOf(c.content))) };
  } catch {
    return { usage, error: part('The AI answer could not be used') };
  }
}

const back = (why: string, coins: number) => (coins === 1 ? part(`${why}. Your token is back`) : part(`${why}. Your ${String(coins)} tokens are back`));

/** D105 phase 2: read a prescription photo with the shop's AI tokens (one page's price, D97 guard), then match it to the shelf. */
export async function readRx(t: TenantContext, actor: Actor, photoData: string) {
  const s = await aiSettings();
  const provider = providerOf(s.model);
  const key = s.enabled ? await apiKey(provider) : null;
  if (!key) throw AppError.forbidden('AI reading is off');
  // One size for every photo: a bounded cost (about 2,500 tokens in), whatever the camera sent.
  const photo = await sharp(Buffer.from(photoData.replace(/^data:[^,]*,/, ''), 'base64'), { limitInputPixels: 50_000_000 })
    .rotate()
    .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
    .catch(() => {
      throw AppError.validation('That is not a photo we can read — take it again');
    });
  const coins = s.coinsPerPage;
  if (!safeNow(s, 'read') || ((await balanceOf(t.shopId)) >= coins && !(await fits(t.shopId, s, worstPage(s))))) {
    await signal('ai_paused');
    throw AppError.conflict('AI reading is paused for your shop — MedBox24 has been told and will sort it out. No tokens were taken.', { reason: AI_PAUSED });
  }
  const read = await inTransaction(async (session) => {
    const [doc] = await AiReadModel.create([{ kind: 'rx', shopId: t.shopId, shopName: t.shopName, userId: new Types.ObjectId(actor.id), userName: actor.name, supplierName: 'Prescription', fileName: 'Prescription photo', fileType: 'image', pages: 1, coins, model: s.model }], { session });
    if (!doc) throw AppError.internal();
    await moveCoins(t.shopId, 'read', -coins, 'AI read a prescription', actor.name, String(doc._id), session);
    return doc;
  });
  const started = Date.now();
  const cost = (u: { input: number; output: number }) => ({ inputTokens: u.input, outputTokens: u.output, costPaise: costPaise(s.model, u.input, u.output, s.usdInr, priceOf(s, s.model)), freeTier: onFreeTier(s, s.model), ms: Date.now() - started });
  const giveBack = async (error: string, usage = { input: 0, output: 0 }) => {
    await inTransaction(async (session) => {
      const claimed = await AiReadModel.updateOne({ _id: read._id, status: 'running' }, { $set: { status: 'failed', refunded: true, error, ...cost(usage) } }, { session });
      if (claimed.modifiedCount) await moveCoins(t.shopId, 'refund', coins, `Back: prescription — ${error}`, actor.name, String(read._id), session);
    });
    return error;
  };

  let answer: Awaited<ReturnType<typeof askClaude>>;
  try {
    answer = provider === 'google' ? await askGemini(photo, s, key) : await askClaude(photo, s, key);
  } catch (err) {
    logger.warn({ err: err instanceof Anthropic.APIError ? { status: typeof err.status === 'number' ? err.status : null, type: err.name } : err instanceof GeminiError ? { status: err.status, type: err.kind } : String(err) }, 'AI prescription read failed');
    await signal(outOfCredit(err) ? 'ai_credit_low' : 'ai_fail');
    const busy = err instanceof Anthropic.RateLimitError || (err instanceof GeminiError && err.kind === 'busy');
    throw new AppError(503, 'SERVICE_UNAVAILABLE', back(part(`Could not read the prescription: ${await giveBack(busy ? part('the AI is busy, try again in a minute') : part('the AI could not be reached'))}`), coins));
  }
  if ('error' in answer && answer.error) throw new AppError(422, 'VALIDATION_ERROR', back(await giveBack(answer.error, answer.usage), coins));
  const rx = 'rx' in answer ? answer.rx : undefined;
  if (!rx?.prescription || !rx.items.length) throw new AppError(422, 'VALIDATION_ERROR', back(await giveBack(part('No medicines found on this photo'), answer.usage), coins));

  const lines: RxLine[] = [];
  for (const it of rx.items.slice(0, 30)) lines.push(await matchLine(t, it));
  await AiReadModel.updateOne({ _id: read._id, status: 'running' }, { $set: { status: 'done', lines: lines.length, ...cost(answer.usage) } });
  return { doctor: rx.doctor.trim(), patient: rx.patient.trim(), lines, ai: { coins, balance: await balanceOf(t.shopId) } };
}
