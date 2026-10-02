import mongoose, { Schema, model, type ClientSession, type Types } from 'mongoose';
import { tenantScoped } from './tenant-scope';

const recordSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    scope: { type: String, required: true },
    key: { type: String, required: true },
    result: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
recordSchema.index({ shopId: 1, scope: 1, key: 1 }, { unique: true });
recordSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
recordSchema.plugin(tenantScoped);

const IdempotencyModel = model('IdempotencyRecord', recordSchema);

const isDuplicate = (err: unknown) => (err as { code?: number }).code === 11000;

/**
 * Runs `work` in a transaction once per (shop, scope, key). A retry of the same request gets the first
 * result back instead of doing the stock or money change twice (PLAN §26).
 */
export async function once<T>(shopId: Types.ObjectId, scope: string, key: string, work: (session: ClientSession) => Promise<T>): Promise<{ result: T; replayed: boolean }> {
  const earlier = async () => {
    const rec = await IdempotencyModel.findOne({ shopId, scope, key }).lean();
    return rec ? { result: rec.result as T, replayed: true } : null;
  };
  const seen = await earlier();
  if (seen) return seen;

  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      await IdempotencyModel.create([{ shopId, scope, key }], { session });
      const out = await work(session);
      await IdempotencyModel.updateOne({ shopId, scope, key }, { $set: { result: out } }, { session });
      return out;
    });
    return { result, replayed: false };
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    const again = await earlier();
    if (again) return again;
    throw err;
  } finally {
    await session.endSession();
  }
}
