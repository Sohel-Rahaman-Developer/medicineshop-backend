import { Router } from 'express';
import mongoose from 'mongoose';
import { supportsTransactions } from '../../config/db';
import { env } from '../../config/env';
import { release } from '../release/release';

export const healthRouter = Router();

const DB_STATE: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

// A real round trip, so a hung database reads as degraded; its time is the API-to-database latency.
async function pingMs(): Promise<number | null> {
  const db = mongoose.connection.db;
  if (!db) return null;
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { resolve(null); }, 3000);
  });
  const ok = await Promise.race([db.command({ ping: 1 }).then(() => true, () => null), timeout]);
  clearTimeout(timer);
  return ok ? Math.round((performance.now() - started) * 10) / 10 : null;
}

healthRouter.get('/', (_req, res, next) => {
  const dbState = DB_STATE[mongoose.connection.readyState] ?? 'unknown';
  (dbState === 'connected' ? pingMs() : Promise.resolve(null))
    .then((ping) => {
      const healthy = ping !== null;
      res.status(healthy ? 200 : 503).json({
        success: healthy,
        data: {
          status: healthy ? 'ok' : 'degraded',
          version: release().version,
          deployedAt: release().deployedAt,
          env: env.NODE_ENV,
          uptimeSeconds: Math.round(process.uptime()),
          db: {
            state: dbState,
            pingMs: ping,
            transactions: healthy ? supportsTransactions() : false,
          },
          time: new Date().toISOString(),
        },
      });
    })
    .catch(next);
});
