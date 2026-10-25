import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { generate, textOf, usageOf, type GeminiContent } from '../../services/gemini';
import type { Price } from '../ai/ai-settings';
import { AI_MODELS, type AiModelId } from '../ai/ai.model';
import type { Voice } from './lang';
import { runTool, toolDefs, type Ctx } from './tools';

// D81: one AI question — Claude with read-only tools, inside the admin's caps. The caps hold for the whole question
// (every round), so its worst cost is known before it starts.

const SYSTEM = `You are the assistant inside MedBox24, the software of a pharmacy shop in India. The shop's own staff ask you questions.
Answer about this shop (its sales, profit and margins, stock, expiry, customers and udhaar, suppliers and their prices, purchases, expenses, GST, staff, cash, branches), about medicines (what a medicine or salt is for, substitutes with the same salt), and about running and growing a pharmacy in India: more sales, stock and expiry control, buying and margins, pricing, customers and loyalty, staff, cash and udhaar, the shop's layout and marketing. For anything else (films, sport, politics, homework, coding, other trades), reply with exactly OFF_TOPIC and nothing else.
Call every tool you need together in one turn. For "why", "vs" or "up or down", start with compare. For advice, first look up the shop's own figures (compare, item_margins, not_selling, buy_prices, busy_hours, low_stock, customer_dues — whichever fit), say what they show, then give two or three concrete steps for this shop, each tied to a figure.
Take every figure from the tools and copy it as given; never invent a number or a name, and never work one out yourself. If a tool says the person's role cannot see something, say so plainly.
Medicines: general information only. Never give a dose for a patient — say to ask a doctor. GST and licences: general guidance only — for a filing, say to ask their CA.
Reply in at most 8 short lines of plain text, no tables and no markdown.`;

const LANGUAGE: Record<Voice, string> = {
  en: 'English',
  hi: 'Hindi in Devanagari script',
  hi_latn: 'Hindi written in Roman letters (Hinglish)',
  bn: 'Bengali in Bengali script',
  bn_latn: 'Bengali written in Roman letters',
};

const ROUNDS = 4;
export const OFF_TOPIC = 'OFF_TOPIC';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type AiAnswer = { kind: 'answer'; text: string; tools: string[]; links: string[] } | { kind: 'off_topic'; tools: string[] } | { kind: 'too_big'; tools: string[] } | { kind: 'refused'; tools: string[] };

/** Paise for a question's tokens at the given price (US$ per million). */
export const costOf = (u: Usage, p: Price, usdInr: number) => Math.round(((u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000) * usdInr * 100);

/** Tokens a tool result may add, counted high (a character can be a token in Bengali). */
const roughTokens = (s: string) => Math.ceil(s.length / 2);

export interface Caps {
  model: AiModelId;
  capIn: number;
  capOut: number;
  price: Price;
}

/**
 * Input tokens as the input cap counts them: each at its own price over the dearest input price, so a cached read
 * costs a tenth of a fresh one and the worst case (cap × dearest price) still holds.
 */
export function inputUsed(u: Usage, p: Price) {
  const top = Math.max(p.input, p.cacheWrite) || 1;
  return (u.input * p.input + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / top;
}

export async function askClaude(c: Ctx, key: string, s: Caps, voice: Voice, question: string, history: Turn[], used: Usage): Promise<AiAnswer> {
  const client = new Anthropic({ apiKey: key, baseURL: env.AI_BASE_URL, maxRetries: 1, timeout: 45_000 });
  const messages: Anthropic.MessageParam[] = [...history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: `${question}\n\n(Reply in ${LANGUAGE[voice]}.)` }];
  const tools = toolDefs();
  const called: string[] = [];
  const links: string[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const room = s.capOut - used.output;
    if (room < 64) return { kind: 'too_big', tools: called };
    const msg = await client.messages.create({
      model: s.model,
      max_tokens: room,
      // The system prompt and tool list are the same for every shop: cached once, read at a tenth of the price.
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
      // Short answers from looked-up figures: little thinking, so the output cap goes to the answer.
      ...(AI_MODELS[s.model].effort ? { output_config: { effort: 'low' as const } } : {}),
    });
    used.input += msg.usage.input_tokens;
    used.output += msg.usage.output_tokens;
    used.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    used.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
    const lastIn = msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
    if (msg.stop_reason === 'refusal') return { kind: 'refused', tools: called };
    if (msg.stop_reason !== 'tool_use') {
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
      if (!text || msg.stop_reason === 'max_tokens') return { kind: 'too_big', tools: called };
      if (text === OFF_TOPIC || text.startsWith(OFF_TOPIC)) return { kind: 'off_topic', tools: called };
      return { kind: 'answer', text, tools: called, links: [...new Set(links)] };
    }
    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const results = await Promise.all(uses.map((u) => runTool(c, u.name, u.input)));
    for (const r of results) {
      called.push(r.name);
      if (r.href) links.push(r.href);
    }
    // The next round reads the whole conversation again: stop now if it would go past the input cap.
    const next = lastIn + msg.usage.output_tokens + results.reduce((a, r) => a + roughTokens(r.text), 0);
    if (inputUsed(used, s.price) + next > s.capIn) return { kind: 'too_big', tools: called };
    messages.push({ role: 'assistant', content: msg.content }, { role: 'user', content: uses.map((u, i) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: results[i]?.text ?? '', is_error: !results[i]?.ok })) });
  }
  return { kind: 'too_big', tools: called };
}

/** D96: the same question on Gemini — the same tools, caps and answer kinds; the model's turns go back as given (thought signatures). */
export async function askGemini(c: Ctx, key: string, s: Caps, voice: Voice, question: string, history: Turn[], used: Usage): Promise<AiAnswer> {
  const contents: GeminiContent[] = [...history.map((h): GeminiContent => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })), { role: 'user', parts: [{ text: `${question}\n\n(Reply in ${LANGUAGE[voice]}.)` }] }];
  const tools = [{ functionDeclarations: toolDefs().map((t) => ({ name: t.name, description: t.description ?? '', parametersJsonSchema: t.input_schema })) }];
  const called: string[] = [];
  const links: string[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const room = s.capOut - used.output;
    if (room < 64) return { kind: 'too_big', tools: called };
    const r = await generate(key, s.model, { systemInstruction: { parts: [{ text: SYSTEM }] }, contents, tools, generationConfig: { maxOutputTokens: room, thinkingConfig: { thinkingLevel: 'low' } } }, { timeoutMs: 45_000, retries: 1 });
    const u = usageOf(r);
    used.input += u.input;
    used.cacheRead += u.cacheRead;
    used.output += u.output;
    const cand = r.candidates?.[0];
    if (r.promptFeedback?.blockReason || !cand?.content || (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason))) return { kind: 'refused', tools: called };
    const calls = cand.content.parts.filter((p) => p.functionCall).map((p) => p.functionCall).filter((f) => f !== undefined);
    if (!calls.length) {
      const text = textOf(cand.content).trim();
      if (!text || cand.finishReason === 'MAX_TOKENS') return { kind: 'too_big', tools: called };
      if (text === OFF_TOPIC || text.startsWith(OFF_TOPIC)) return { kind: 'off_topic', tools: called };
      return { kind: 'answer', text, tools: called, links: [...new Set(links)] };
    }
    const results = await Promise.all(calls.map((f) => runTool(c, f.name, f.args ?? {})));
    for (const x of results) {
      called.push(x.name);
      if (x.href) links.push(x.href);
    }
    const next = u.input + u.cacheRead + u.output + results.reduce((a, x) => a + roughTokens(x.text), 0);
    if (inputUsed(used, s.price) + next > s.capIn) return { kind: 'too_big', tools: called };
    contents.push(cand.content, { role: 'user', parts: calls.map((f, i) => ({ functionResponse: { ...(f.id ? { id: f.id } : {}), name: f.name, response: results[i]?.ok ? { result: results[i].text } : { error: results[i]?.text ?? '' } } })) });
  }
  return { kind: 'too_big', tools: called };
}
