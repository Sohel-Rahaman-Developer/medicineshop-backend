import { Schema, model } from 'mongoose';
import { logger } from '../config/logger';

export const SIGNALS = {
  server_error: { label: 'Server errors (5xx)', limit: 5 },
  login_fail: { label: 'Wrong shop sign-in codes', limit: 30 },
  admin_login_fail: { label: 'Wrong admin codes (email, authenticator, unlock)', limit: 5 },
  webhook_bad_signature: { label: 'Payment webhooks with a bad signature', limit: 1 },
  job_fail: { label: 'Scheduled jobs that failed', limit: 1 },
  mail_fail: { label: 'Emails given up after 3 tries', limit: 1 },
  ai_fail: { label: 'AI calls that failed — bill reads and chat (key, Anthropic down)', limit: 3 },
  ask_budget: { label: 'Shop chat stopped: this month’s AI budget is used up', limit: 1 },
} as const;
export type Signal = keyof typeof SIGNALS;
export const ALERT_WINDOW_MIN = 15;

const BUCKET_MS = 5 * 60_000;
const schema = new Schema({ kind: { type: String, required: true }, at: { type: Date, required: true }, n: { type: Number, default: 0 } }, { versionKey: false });
schema.index({ kind: 1, at: 1 }, { unique: true });
schema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
export const SignalModel = model('MonitorSignal', schema);

/** Counts one event into its 5-minute bucket. Never throws: monitoring must not break the request it watches. */
export async function signal(kind: Signal, now = new Date()) {
  const at = new Date(Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS);
  await SignalModel.updateOne({ kind, at }, { $inc: { n: 1 } }, { upsert: true }).catch((err: unknown) => {
    logger.warn({ err, kind }, 'Monitor signal not saved');
  });
}

async function totals(from: Date, to: Date) {
  const rows = await SignalModel.aggregate<{ _id: Signal; n: number }>([{ $match: { at: { $gte: from, $lte: to } } }, { $group: { _id: '$kind', n: { $sum: '$n' } } }]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

/** Signals at or over their limit in the last 15 minutes. */
export async function overLimit(now = new Date()) {
  const n = await totals(new Date(now.getTime() - ALERT_WINDOW_MIN * 60_000), now);
  return (Object.keys(SIGNALS) as Signal[]).filter((k) => (n.get(k) ?? 0) >= SIGNALS[k].limit).map((k) => ({ kind: k, n: n.get(k) ?? 0, ...SIGNALS[k] }));
}

/** Every signal's count over the last 24 hours and the last 15 minutes, for the admin health page. */
export async function signalSummary(now = new Date()) {
  const [day, recent] = await Promise.all([totals(new Date(now.getTime() - 24 * 60 * 60_000), now), totals(new Date(now.getTime() - ALERT_WINDOW_MIN * 60_000), now)]);
  return (Object.keys(SIGNALS) as Signal[]).map((k) => ({ kind: k, label: SIGNALS[k].label, limit: SIGNALS[k].limit, last24h: day.get(k) ?? 0, last15m: recent.get(k) ?? 0 }));
}
