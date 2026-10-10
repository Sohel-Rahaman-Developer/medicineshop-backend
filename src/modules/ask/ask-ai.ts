import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import type { Price } from '../ai/ai-settings';
import type { AiModelId } from '../ai/ai.model';
import type { Voice } from './lang';
import { runTool, toolDefs, type Ctx } from './tools';

// D81: one AI question — Claude with read-only tools, inside the admin's caps. The caps hold for the whole question
// (every round), so its worst cost is known before it starts.

const SYSTEM = `You are the assistant inside MedShop, the software of a pharmacy shop in India. The shop's own staff ask you questions.
Answer only about this shop (its sales, profit, stock, expiry, customers' udhaar, suppliers, cash) or about medicines (what a medicine or salt is for, substitutes with the same salt). For anything else, reply with exactly OFF_TOPIC and nothing else.
Take every figure from the tools and copy it as given; never invent a number or a name. If a tool says the person's role cannot see something, say so plainly.
Medicines: general information only. Never give a dose for a patient — say to ask a doctor.
Reply in at most 6 short lines of plain text, no tables and no markdown.`;

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

export async function askClaude(c: Ctx, key: string, s: { model: AiModelId; capIn: number; capOut: number }, voice: Voice, question: string, history: Turn[], used: Usage): Promise<AiAnswer> {
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
    if (used.input + used.cacheRead + used.cacheWrite + next > s.capIn) return { kind: 'too_big', tools: called };
    messages.push({ role: 'assistant', content: msg.content }, { role: 'user', content: uses.map((u, i) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: results[i]?.text ?? '', is_error: !results[i]?.ok })) });
  }
  return { kind: 'too_big', tools: called };
}
