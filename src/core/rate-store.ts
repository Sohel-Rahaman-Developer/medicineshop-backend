import { Schema, model } from 'mongoose';
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';

// Hits per key, shared by every API worker. A row lives for its window only: the TTL index clears it, nothing is permanent.
const hitSchema = new Schema({ _id: { type: String, required: true }, hits: { type: Number, required: true }, resetAt: { type: Date, required: true } }, { versionKey: false });
hitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });
export const RateHitModel = model('RateHit', hitSchema);

/** A rate-limit store in MongoDB, so a limit holds however many API workers share the traffic. */
export class SharedStore implements Store {
  windowMs = 60_000;
  localKeys = false;

  constructor(readonly prefix: string) {}

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const row = await RateHitModel.findById(this.prefix + key).lean();
    return row && row.resetAt > new Date() ? { totalHits: row.hits, resetTime: row.resetAt } : undefined;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const id = this.prefix + key;
    const now = new Date();
    const live = await RateHitModel.findOneAndUpdate({ _id: id, resetAt: { $gt: now } }, { $inc: { hits: 1 } }, { returnDocument: 'after' }).lean();
    if (live) return { totalHits: live.hits, resetTime: live.resetAt };
    // First hit, or the window is over: start afresh. Two workers racing here can both write 1 — off by one at most.
    const resetAt = new Date(now.getTime() + this.windowMs);
    await RateHitModel.updateOne({ _id: id }, { $set: { hits: 1, resetAt } }, { upsert: true });
    return { totalHits: 1, resetTime: resetAt };
  }

  async decrement(key: string) {
    await RateHitModel.updateOne({ _id: this.prefix + key, hits: { $gt: 0 } }, { $inc: { hits: -1 } });
  }

  async resetKey(key: string) {
    await RateHitModel.deleteOne({ _id: this.prefix + key });
  }
}
