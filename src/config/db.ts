import mongoose from 'mongoose';
import { env, isDev } from './env';
import { logger } from './logger';

let connected = false;

/**
 * Atlas sits behind NATs and firewalls that silently drop a TCP connection left idle for minutes; a query sent on one
 * never gets an answer. Idle pool connections are closed first, and a stuck one fails fast so the read is retried.
 */
export const DB_OPTIONS = {
  serverSelectionTimeoutMS: 10_000,
  maxPoolSize: 20,
  maxIdleTimeMS: 30_000,
  // Under nginx's 60 s, so a stuck query errors and is retried instead of the page waiting minutes.
  socketTimeoutMS: 45_000,
} satisfies mongoose.ConnectOptions;

export async function connectDb(): Promise<typeof mongoose> {
  if (connected) return mongoose;

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

  await mongoose.connect(env.MONGODB_URI, DB_OPTIONS);

  connected = true;
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  await mongoose.connection.close();
  connected = false;
}

export function supportsTransactions(): boolean {
  const topology = (mongoose.connection as unknown as { client?: { topology?: { s?: { description?: { type?: string } } } } })
    .client?.topology?.s?.description?.type;
  return topology === 'ReplicaSetWithPrimary' || topology === 'Sharded';
}
