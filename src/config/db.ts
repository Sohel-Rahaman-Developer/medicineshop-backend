/**
 * MongoDB connection.
 *
 * NOTE (important): POS sale ek atomic operation hai — bill banna, stock kam
 * hona, ledger entry, loyalty points — sab ek saath ya kuch bhi nahi. Iske liye
 * MongoDB transactions chahiye, aur transactions ke liye REPLICA SET chahiye.
 * Atlas par ye by default milta hai. Local standalone `mongod` par transaction
 * fail karega — us case me `mongodb-memory-server` ya Atlas use karo.
 */
import mongoose from 'mongoose';
import { env, isDev } from './env';
import { logger } from './logger';

let connected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (connected) return mongoose;

  // Strict query: schema me define na kiye gaye field par filter chup-chaap
  // ignore na ho, error aaye.
  mongoose.set('strictQuery', true);
  if (isDev) mongoose.set('debug', false); // zaroorat pade to true kar lena

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
 * Kya ye deployment transactions support karta hai?
 * Sale/purchase jaise multi-document writes se pehle check kar sakte ho.
 */
export function supportsTransactions(): boolean {
  const topology = (mongoose.connection as unknown as { client?: { topology?: { s?: { description?: { type?: string } } } } })
    .client?.topology?.s?.description?.type;
  return topology === 'ReplicaSetWithPrimary' || topology === 'Sharded';
}
