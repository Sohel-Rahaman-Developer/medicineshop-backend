import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import type { RequestHandler, Response } from 'express';
import mongoose, { Schema, Types, model } from 'mongoose';
import { allowedOrigins, env } from '../../config/env';
import { logger } from '../../config/logger';

/** A request slower than this on the server is kept for the admin's Speed panel. */
export const SLOW_MS = 1000;
const KEEP_DAYS = 7;

const sampleSchema = new Schema(
  {
    at: { type: Date, required: true },
    source: { type: String, enum: ['server', 'browser'], required: true },
    kind: { type: String, enum: ['api', 'page', 'load', 'asset'], required: true },
    path: { type: String, required: true },
    screen: { type: String, default: '' },
    ms: { type: Number, required: true },
    server: { type: Number, default: null },
    db: { type: Number, default: null },
    queries: { type: Number, default: null },
    status: { type: Number, default: null },
    shopId: { type: Schema.Types.ObjectId, default: null },
  },
  { versionKey: false },
);
sampleSchema.index({ at: 1 }, { expireAfterSeconds: KEEP_DAYS * 24 * 60 * 60 });

export const PerfSampleModel = model('PerfSample', sampleSchema);
export type PerfSampleInput = { kind: 'api' | 'page' | 'load' | 'asset'; path: string; screen: string; ms: number; server: number | null; db: number | null };

type Timing = { db: number; queries: number };
const als = new AsyncLocalStorage<Timing>();

// Every query and aggregate counts toward the request it runs in; parallel ones add up, so db can pass the total.
function timeExec(proto: { exec: (...args: unknown[]) => Promise<unknown> }) {
  const exec = proto.exec;
  proto.exec = async function (this: unknown, ...args: unknown[]) {
    const t = als.getStore();
    if (!t) return exec.apply(this, args);
    const start = performance.now();
    try {
      return await exec.apply(this, args);
    } finally {
      t.db += performance.now() - start;
      t.queries += 1;
    }
  };
}
timeExec(mongoose.Query.prototype);
timeExec(mongoose.Aggregate.prototype);

/** Ids, numbers and tokens become placeholders, so one screen is one row however many records it opens. */
export function pathKey(url: string): string {
  const path = (url.split('?')[0] ?? '').replace(env.API_PREFIX, '') || '/';
  return path
    .split('/')
    .map((s) => (/^[a-f0-9]{24}$/i.test(s) ? ':id' : /^\d+$/.test(s) ? ':n' : s.length >= 16 && /\d/.test(s) ? ':token' : s))
    .join('/')
    .slice(0, 120);
}

type RouteStat = { n: number; ms: number; max: number; db: number; queries: number; slow: number };
const routes = new Map<string, RouteStat>();
const since = new Date();
const MAX_ROUTES = 400;
let kept = { minute: 0, n: 0 };

// Each API worker writes its route totals every minute; the Speed panel adds up the workers heard from in 3 minutes.
const workerSchema = new Schema(
  {
    _id: { type: String, required: true },
    since: { type: Date, required: true },
    at: { type: Date, required: true },
    routes: { type: [{ _id: false, path: { type: String, required: true }, n: Number, ms: Number, max: Number, dbMs: Number, queries: Number, slow: Number }], default: [] },
  },
  { versionKey: false },
);
workerSchema.index({ at: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
export const PerfWorkerModel = model('PerfWorker', workerSchema);
const ME = `${hostname()}:${String(process.pid)}`;
const LIVE_MS = 3 * 60_000;
let flushing: NodeJS.Timeout | null = null;
const snapshot = () => [...routes.entries()].map(([path, s]) => ({ path, n: s.n, ms: s.ms, max: s.max, dbMs: s.db, queries: s.queries, slow: s.slow }));
function flush() {
  PerfWorkerModel.updateOne({ _id: ME }, { $set: { since, at: new Date(), routes: snapshot() } }, { upsert: true }).catch((err: unknown) => { logger.warn({ err }, 'perf totals not saved'); });
}

const round = (n: number) => Math.round(n);

function keep(doc: Record<string, unknown>) {
  const minute = Math.floor(Date.now() / 60_000);
  if (kept.minute !== minute) kept = { minute, n: 0 };
  if (++kept.n > 120) return;
  PerfSampleModel.create(doc).catch((err: unknown) => { logger.warn({ err }, 'perf sample not saved'); });
}

function headerOn(res: Response, value: () => string) {
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    if (!res.headersSent) res.setHeader('Server-Timing', value());
    return writeHead(...args);
  }) as Response['writeHead'];
}

/** Server-Timing on every API answer (app = total, db = query time) and per-route totals since the server started. */
export const timing: RequestHandler = (req, res, next) => {
  if (!req.path.startsWith(env.API_PREFIX)) return next();
  if (!flushing) {
    flushing = setInterval(flush, 60_000);
    flushing.unref();
  }
  const t: Timing = { db: 0, queries: 0 };
  const start = performance.now();
  const origin = req.get('origin');
  if (origin && allowedOrigins.includes(origin)) res.setHeader('Timing-Allow-Origin', origin);
  headerOn(res, () => `app;dur=${(performance.now() - start).toFixed(1)}, db;dur=${t.db.toFixed(1)};desc="${String(t.queries)} queries"`);
  res.on('finish', () => {
    const key = `${req.method} ${pathKey(req.originalUrl)}`;
    if (key.endsWith(' /health') || key.endsWith(' /perf')) return;
    const ms = performance.now() - start;
    const s = routes.get(key) ?? (routes.size < MAX_ROUTES ? { n: 0, ms: 0, max: 0, db: 0, queries: 0, slow: 0 } : null);
    if (s) {
      s.n += 1; s.ms += ms; s.db += t.db; s.queries += t.queries; s.max = Math.max(s.max, ms);
      if (ms >= SLOW_MS) s.slow += 1;
      routes.set(key, s);
    }
    if (ms < SLOW_MS) return;
    const shop = req.get('x-shop-id');
    keep({ at: new Date(), source: 'server', kind: 'api', path: key, ms: round(ms), server: round(ms), db: round(t.db), queries: t.queries, status: res.statusCode, shopId: shop && Types.ObjectId.isValid(shop) && res.statusCode < 400 ? new Types.ObjectId(shop) : null });
  });
  als.run(t, next);
};

/** Slow loads a signed-in browser saw: the wait the person had, not only the server's part of it. */
export async function recordBrowser(items: PerfSampleInput[]) {
  const at = new Date();
  await PerfSampleModel.insertMany(items.map((i) => ({ ...i, at, source: 'browser', ms: round(i.ms), server: i.server === null ? null : round(i.server), db: i.db === null ? null : round(i.db) })));
}

const avg = (sum: number, n: number) => (n ? round(sum / n) : 0);

export async function perfOverview(now = new Date()) {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [groups, recent] = await Promise.all([
    PerfSampleModel.aggregate<{ _id: { source: string; kind: string; path: string }; n: number; ms: number; max: number; server: number | null; db: number | null; queries: number | null; last: Date }>([
      { $match: { at: { $gte: day } } },
      { $group: { _id: { source: '$source', kind: '$kind', path: '$path' }, n: { $sum: 1 }, ms: { $avg: '$ms' }, max: { $max: '$ms' }, server: { $avg: '$server' }, db: { $avg: '$db' }, queries: { $avg: '$queries' }, last: { $max: '$at' } } },
      { $sort: { n: -1, ms: -1 } },
      { $limit: 40 },
    ]),
    PerfSampleModel.find({}).sort({ at: -1 }).limit(25).lean(),
  ]);
  // This worker live, the others from their last minute's write.
  const others = await PerfWorkerModel.find({ _id: { $ne: ME }, at: { $gte: new Date(now.getTime() - LIVE_MS) } }).lean();
  const workers = [{ since, routes: snapshot() }, ...others.map((o) => ({ since: o.since, routes: o.routes.map((r) => ({ path: r.path, n: r.n ?? 0, ms: r.ms ?? 0, max: r.max ?? 0, dbMs: r.dbMs ?? 0, queries: r.queries ?? 0, slow: r.slow ?? 0 })) }))];
  const merged = new Map<string, RouteStat>();
  for (const w of workers) {
    for (const r of w.routes) {
      const m = merged.get(r.path) ?? { n: 0, ms: 0, max: 0, db: 0, queries: 0, slow: 0 };
      m.n += r.n; m.ms += r.ms; m.db += r.dbMs; m.queries += r.queries; m.slow += r.slow; m.max = Math.max(m.max, r.max);
      merged.set(r.path, m);
    }
  }
  const top = [...merged.entries()]
    .map(([path, s]) => ({ path, n: s.n, avg: avg(s.ms, s.n), max: round(s.max), db: avg(s.db, s.n), queries: s.n ? Math.round((s.queries / s.n) * 10) / 10 : 0, slow: s.slow }))
    .sort((a, b) => b.avg * b.n - a.avg * a.n)
    .slice(0, 25);
  return {
    since: workers.reduce((a, w) => (w.since < a ? w.since : a), since),
    workers: workers.map((w) => ({ since: w.since, requests: w.routes.reduce((a, r) => a + r.n, 0) })),
    slowMs: SLOW_MS,
    routes: top,
    slow24h: groups.map((g) => ({ source: g._id.source, kind: g._id.kind, path: g._id.path, n: g.n, avg: round(g.ms), max: round(g.max), server: g.server === null ? null : round(g.server), db: g.db === null ? null : round(g.db), queries: g.queries === null ? null : Math.round(g.queries * 10) / 10, last: g.last })),
    recent: recent.map((r) => ({ at: r.at, source: r.source, kind: r.kind, path: r.path, screen: r.screen, ms: r.ms, server: r.server ?? null, db: r.db ?? null, queries: r.queries ?? null, status: r.status ?? null })),
  };
}
