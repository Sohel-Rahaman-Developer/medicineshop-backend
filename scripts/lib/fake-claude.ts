import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** What the next /v1/messages call answers. */
export type Reply =
  | { bill: unknown; input?: number; output?: number }
  | { status: number; type?: string }
  | { text: string }
  | { stop: 'refusal' | 'max_tokens' };

export interface Seen {
  key: string;
  model: string;
  effort: string | null;
  stream: boolean;
  system: string;
  blocks: string[];
  schema: boolean;
}

export interface FakeClaude {
  url: string;
  /** The key it accepts; any other gets 401 like Anthropic. */
  key: string;
  /** One-off replies, used in order; when empty, `answer`. */
  queue: Reply[];
  answer: Reply;
  seen: Seen[];
  close: () => Promise<void>;
}

const sse = (res: ServerResponse, events: [string, unknown][]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

const fail = (res: ServerResponse, status: number, type: string) => {
  res.writeHead(status, { 'content-type': 'application/json', 'retry-after-ms': '5' });
  res.end(JSON.stringify({ type: 'error', error: { type, message: type } }));
};

/** A stand-in for api.anthropic.com: the Messages API (streamed) and Models API, enough for the SDK. */
export async function startFakeClaude(key = 'sk-ant-api03-fake-test-key-0123456789abcdefghij'): Promise<FakeClaude> {
  const fake: FakeClaude = { url: '', key, queue: [], answer: { status: 500, type: 'api_error' }, seen: [], close: () => Promise.resolve() };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.headers['x-api-key'] !== fake.key) {
        fail(res, 401, 'authentication_error');
        return;
      }
      const models = /^\/v1\/models\/([\w.-]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && models) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'model', id: models[1], display_name: `Fake ${models[1] ?? ''}`, created_at: '2026-01-01T00:00:00Z' }));
        return;
      }
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        fail(res, 404, 'not_found_error');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean; system?: string; output_config?: { effort?: string; format?: unknown }; messages: { content: { type: string }[] }[] };
      fake.seen.push({ key: fake.key, model: body.model, effort: body.output_config?.effort ?? null, stream: body.stream === true, system: body.system ?? '', blocks: body.messages.flatMap((m) => m.content.map((c) => c.type)), schema: Boolean(body.output_config?.format) });
      const reply = fake.queue.shift() ?? fake.answer;
      if ('status' in reply) {
        fail(res, reply.status, reply.type ?? 'api_error');
        return;
      }
      const text = 'bill' in reply ? JSON.stringify(reply.bill) : 'text' in reply ? reply.text : '';
      const stop = 'stop' in reply ? reply.stop : 'end_turn';
      const usage = 'bill' in reply ? { input: reply.input ?? 3200, output: reply.output ?? 2400 } : { input: 3000, output: 100 };
      sse(res, [
        ['message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, Math.ceil(text.length / 2)) } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(Math.ceil(text.length / 2)) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  fake.url = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
  fake.close = () => new Promise<void>((ok) => server.close(() => { ok(); }));
  return fake;
}
