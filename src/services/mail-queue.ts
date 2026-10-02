import { Schema, model, type Types } from 'mongoose';
import { logger } from '../config/logger';
import { sendMail, type MailInput } from './mailer';

// PLAN §17 email queue without Redis: a request only queues; the minute job sends, retrying 1 → 5 → 30 min.
const jobSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop' },
    kind: { type: String, required: true },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    html: { type: String, required: true },
    text: { type: String, required: true },
    status: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], required: true, default: 'pending' },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 3 },
    lastError: { type: String, default: '' },
    scheduledFor: { type: Date, required: true },
    sentAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
jobSchema.index({ status: 1, scheduledFor: 1 });
jobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
export const EmailJobModel = model('EmailJob', jobSchema);

const BACKOFF_MIN = [1, 5, 30];
const STUCK_MS = 10 * 60 * 1000;

export async function queueMail(mail: MailInput & { kind: string; shopId?: Types.ObjectId }, at = new Date()) {
  await EmailJobModel.create({ ...mail, scheduledFor: at });
}

/** Sends what is due, at most `limit`; each job is claimed first so two workers never send it twice. */
export async function drainMail(now = new Date(), limit = 50) {
  // A worker that died mid-send leaves "sending"; after 10 minutes it is due again.
  await EmailJobModel.updateMany({ status: 'sending', updatedAt: { $lt: new Date(now.getTime() - STUCK_MS) } }, { $set: { status: 'pending' } });
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const job = await EmailJobModel.findOneAndUpdate({ status: 'pending', scheduledFor: { $lte: now } }, { $set: { status: 'sending' }, $inc: { attempts: 1 } }, { sort: { scheduledFor: 1 }, returnDocument: 'after' }).lean();
    if (!job) break;
    try {
      await sendMail({ to: job.to, subject: job.subject, html: job.html, text: job.text });
      await EmailJobModel.updateOne({ _id: job._id }, { $set: { status: 'sent', sentAt: new Date(), lastError: '' } });
      sent++;
    } catch (err) {
      const last = job.attempts >= job.maxAttempts;
      const wait = BACKOFF_MIN[Math.min(job.attempts - 1, BACKOFF_MIN.length - 1)] ?? 30;
      await EmailJobModel.updateOne({ _id: job._id }, { $set: { status: last ? 'failed' : 'pending', lastError: (err as Error).message.slice(0, 300), scheduledFor: new Date(now.getTime() + wait * 60_000) } });
      if (last) logger.error({ jobId: String(job._id), kind: job.kind }, 'Email failed 3 times — giving up');
      failed++;
    }
  }
  return { sent, failed };
}
