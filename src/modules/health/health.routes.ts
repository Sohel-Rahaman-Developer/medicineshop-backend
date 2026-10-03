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

healthRouter.get('/', (_req, res) => {
  const dbState = DB_STATE[mongoose.connection.readyState] ?? 'unknown';
  const healthy = dbState === 'connected';

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
        transactions: healthy ? supportsTransactions() : false,
      },
      time: new Date().toISOString(),
    },
  });
});
