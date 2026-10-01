import mongoose from 'mongoose';
import { env, isDev } from './env';
import { logger } from './logger';

let connected = false;

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

export function supportsTransactions(): boolean {
  const topology = (mongoose.connection as unknown as { client?: { topology?: { s?: { description?: { type?: string } } } } })
    .client?.topology?.s?.description?.type;
  return topology === 'ReplicaSetWithPrimary' || topology === 'Sharded';
}
