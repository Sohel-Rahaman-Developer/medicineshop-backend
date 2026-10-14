import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** What the next generateContent call answers. */
export type GeminiReply =
  | { bill: unknown; input?: number; output?: number; thoughts?: number }
  | { status: number; message?: string }
  | { finish: 'SAFETY' | 'MAX_TOKENS' | 'RECITATION' }
  | { block: string }
  /** Chat: call these functions, or answer this text. */
  | { tools: { name: string; args: unknown }[]; input?: number; output?: number }
  | { say: string; input?: number; output?: number; cached?: number };

export interface GeminiSeen {
  key: string;
  method: string;
  model: string;
  body: {
    systemInstruction?: { parts: { text: string }[] };
    contents?: { role: string; parts: Record<string, unknown>[] }[];
    tools?: { functionDeclarations: { name: string; parametersJsonSchema?: unknown }[] }[];
    generationConfig?: { maxOutputTokens?: number; responseMimeType?: string; responseJsonSchema?: Record<string, unknown>; thinkingConfig?: { thinkingLevel?: string } };
  };
}

export interface FakeGemini {
  url: string;
  /** The key it accepts; any other gets Google's 400 API_KEY_INVALID. */
  key: string;
  queue: GeminiReply[];
  answer: GeminiReply;
  seen: GeminiSeen[];
  close: () => Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A stand-in for generativelanguage.googleapis.com: models.get and models.generateContent (v1beta). */
export async function startFakeGemini(key = 'AIzaSyFakeGeminiTestKey0123456789abcdefg'): Promise<FakeGemini> { // gitleaks:allow
  const fake: FakeGemini = { url: '', key, queue: [], answer: { status: 500 }, seen: [], close: () => Promise.resolve() };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const m = /^\/v1beta\/models\/([\w.-]+)(:generateContent)?$/.exec(req.url ?? '');
      const got = String(req.headers['x-goog-api-key'] ?? '');
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as GeminiSeen['body']) : {};
      fake.seen.push({ key: got, method: req.method ?? '', model: m?.[1] ?? '', body });
      if (got !== fake.key) {
        send(res, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
        return;
      }
      if (!m) {
        send(res, 404, { error: { code: 404, status: 'NOT_FOUND' } });
        return;
      }
      if (req.method === 'GET' && !m[2]) {
        send(res, 200, { name: `models/${m[1] ?? ''}`, displayName: `Fake ${m[1] ?? ''}` });
        return;
      }
      const reply = fake.queue.shift() ?? fake.answer;
      if ('status' in reply) {
        send(res, reply.status, { error: { code: reply.status, message: reply.message ?? 'error', status: reply.status === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL' } });
        return;
      }
      if ('block' in reply) {
        send(res, 200, { promptFeedback: { blockReason: reply.block }, usageMetadata: { promptTokenCount: 900 } });
        return;
      }
      if ('finish' in reply) {
        send(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: '{"invoiceNumber":' }] }, finishReason: reply.finish }], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 100 } });
        return;
      }
      if ('tools' in reply) {
        const parts = reply.tools.map((t, i) => ({ functionCall: { id: `call_${String(fake.seen.length)}_${String(i)}`, name: t.name, args: t.args }, ...(i === 0 ? { thoughtSignature: `sig-${String(fake.seen.length)}` } : {}) }));
        send(res, 200, { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: reply.input ?? 1200, candidatesTokenCount: reply.output ?? 40, thoughtsTokenCount: 20 } });
        return;
      }
      if ('say' in reply) {
        send(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking it over', thought: true }, { text: reply.say }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: reply.input ?? 1200, cachedContentTokenCount: reply.cached ?? 0, candidatesTokenCount: reply.output ?? 60 } });
        return;
      }
      const text = JSON.stringify(reply.bill);
      send(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: reply.input ?? 3200, candidatesTokenCount: reply.output ?? 2000, thoughtsTokenCount: reply.thoughts ?? 400 } });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  fake.url = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
  fake.close = () => new Promise<void>((ok) => server.close(() => { ok(); }));
  return fake;
}
