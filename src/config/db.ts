/**
 * MongoDB connection.
 *
 * IMPORTANT: a POS sale is one atomic operation — the bill, the stock
 * deduction, the ledger entry and the loyalty points either all land or none
 * do. That needs MongoDB transactions, and transactions need a REPLICA SET.
 * Atlas provides one by default. A standalone local `mongod` does not, and
 * transactions will fail there — use Atlas or `mongodb-memory-server` instead.
 */
import mongoose from 'mongoose';
import { env, isDev } from './env';
import { logger } from './logger';

let connected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (connected) return mongoose;

  // Strict query: filtering on a field the schema does not define should be
  // an error, not silently ignored.
  mongoose.set('strictQuery', true);
  if (isDev) mongoose.set('debug', false); // flip to true when you need query logs

  mongoose.connection.on('connected', () => {
    logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  });
  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });

  connected = true;
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  await mongoose.connection.close();
  connected = false;
}

/**
 * Does this deployment support transactions?
 * Worth checking before multi-document writes such as sales and purchases.
 */
export function supportsTransactions(): boolean {
  const topology = (mongoose.connection as unknown as { client?: { topology?: { s?: { description?: { type?: string } } } } })
    .client?.topology?.s?.description?.type;
  return topology === 'ReplicaSetWithPrimary' || topology === 'Sharded';
}
