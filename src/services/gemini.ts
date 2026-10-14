import { env } from '../config/env';

// D96: Google's Gemini API (generateContent, v1beta) over plain fetch. The key goes in a header, never in the URL,
// so it can't land in a proxy log.

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  thought?: boolean;
  thoughtSignature?: string;
}
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
export interface GeminiRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  tools?: { functionDeclarations: { name: string; description: string; parametersJsonSchema: unknown }[] }[];
  generationConfig?: { maxOutputTokens?: number; responseMimeType?: string; responseJsonSchema?: unknown; thinkingConfig?: { thinkingLevel: 'low' | 'medium' | 'high' } };
}
export interface GeminiResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** refused: the key is wrong or not allowed; busy: quota or rate limit (the free tier's limits are small); down: no answer. */
export class GeminiError extends Error {
  constructor(
    readonly kind: 'refused' | 'busy' | 'missing' | 'down',
    readonly status: number | null,
  ) {
    super(`Gemini ${kind}${status ? ` (${String(status)})` : ''}`);
  }
}

const base = () => `${env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com'}/v1beta`;

function kindOf(status: number): GeminiError['kind'] {
  if (status === 400 || status === 401 || status === 403) return 'refused';
  if (status === 404) return 'missing';
  if (status === 429) return 'busy';
  return 'down';
}

async function call<T>(method: 'GET' | 'POST', path: string, key: string, body: unknown, timeoutMs: number, retries: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base()}${path}`, { method, headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      if (attempt < retries) continue;
      throw new GeminiError('down', null);
    }
    if (res.ok) return (await res.json()) as T;
    // A 400 is a bad key only when Google says so; any other 400 is our request, which a retry won't fix.
    const text = await res.text().catch(() => '');
    const kind = res.status === 400 && !/API_KEY_INVALID|API key/i.test(text) ? 'down' : kindOf(res.status);
    if ((res.status >= 500 || res.status === 408) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    throw new GeminiError(kind, res.status);
  }
}

export const generate = (key: string, model: string, req: GeminiRequest, o: { timeoutMs: number; retries: number }) => call<GeminiResponse>('POST', `/models/${encodeURIComponent(model)}:generateContent`, key, req, o.timeoutMs, o.retries);

export const modelInfo = (key: string, model: string) => call<{ name: string; displayName?: string }>('GET', `/models/${encodeURIComponent(model)}`, key, undefined, 20_000, 0);

/** Tokens as both providers count them: thinking is billed as output; cached prompt tokens on their own. */
export function usageOf(r: GeminiResponse) {
  const u = r.usageMetadata ?? {};
  const cached = u.cachedContentTokenCount ?? 0;
  return { input: (u.promptTokenCount ?? 0) - cached, cacheRead: cached, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
}

/** The answer's visible text (thought summaries left out). */
export const textOf = (c: GeminiContent | undefined) => (c?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');

/** Gemini accepts a subset of JSON Schema: the $schema tag is dropped. */
export function schemaFor(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}
