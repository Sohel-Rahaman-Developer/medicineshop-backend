import { Schema, model } from 'mongoose';
import { logger } from '../config/logger';

// One row: is the mail server taking our mail? /health shows it, so an outside uptime check can alert when our own mailbox cannot.
const schema = new Schema({ _id: { type: String, required: true }, ok: { type: Boolean, required: true }, since: { type: Date, required: true }, lastError: { type: String, default: '' }, checkedAt: { type: Date, required: true } }, { versionKey: false });
export const MailHealthModel = model('MailHealth', schema);

const ID = 'mail';
export const RECHECK_MIN = 15;

/** Never throws: a status write must not turn a sent email into an error. */
export async function markMail(ok: boolean, err?: unknown, now = new Date()) {
  try {
    if (ok) await MailHealthModel.updateOne({ _id: ID, ok: false }, { $set: { ok: true, since: now, lastError: '', checkedAt: now } });
    // "since" keeps the first failure's time while it stays failing.
    else await MailHealthModel.updateOne({ _id: ID }, [{ $set: { ok: false, since: { $cond: [{ $eq: ['$ok', false] }, '$since', now] }, lastError: ((err as Error | undefined)?.message ?? 'unknown').slice(0, 200), checkedAt: now } }], { upsert: true, updatePipeline: true });
  } catch (e) {
    logger.warn({ err: e }, 'Mail status not saved');
  }
}

/** 'failing' from the first refused email until one goes through. */
export async function mailState() {
  const row = await MailHealthModel.findById(ID).lean();
  return row && !row.ok ? { state: 'failing' as const, since: row.since, lastError: row.lastError } : { state: 'ok' as const, since: null, lastError: '' };
}

/** While failing, one login check every 15 minutes clears it once the mailbox is fixed; never more often, so the mail host sees few failed logins. */
export async function recheckMail(verify: () => Promise<boolean>, now = new Date()) {
  const due = await MailHealthModel.findOneAndUpdate({ _id: ID, ok: false, checkedAt: { $lte: new Date(now.getTime() - RECHECK_MIN * 60_000) } }, { $set: { checkedAt: now } }).lean();
  if (!due) return null;
  const ok = await verify();
  if (ok) await markMail(true, undefined, now);
  return ok;
}
