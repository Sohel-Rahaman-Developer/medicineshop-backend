import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { signal } from '../../services/monitor';
import { OtpTokenModel } from '../auth/models/otp-token.model';
import { DEMO_EMAIL, DemoModel } from './demo.model';

const HOUR = 3_600_000;
const LOCK_AFTER = 10;

/** Sign-in for the demo address: its own code from the admin console, no email. Staff addresses never sign in. */
export async function demoToken(email: string, ctx: { ip?: string; userAgent?: string }) {
  const d = await DemoModel.findById('demo').select('codeHash lockedUntil').lean();
  await OtpTokenModel.updateMany({ audience: 'shop', email, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (email !== DEMO_EMAIL || !d?.codeHash || (d.lockedUntil && d.lockedUntil > new Date())) return;
  await OtpTokenModel.create({ email, otpHash: d.codeHash, audience: 'shop', maxAttempts: env.OTP_MAX_ATTEMPTS, expiresAt: new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000), ip: ctx.ip, userAgent: ctx.userAgent });
}

/** Ten wrong codes in an hour lock the demo sign-in for an hour and alert the super admins. */
export async function demoFailed(now = new Date()) {
  const d = await DemoModel.findOneAndUpdate({ _id: 'demo' }, { $push: { fails: { $each: [now], $slice: -20 } } }, { returnDocument: 'after' }).lean();
  if (!d || d.fails.filter((f) => f.getTime() > now.getTime() - HOUR).length < LOCK_AFTER) return;
  await DemoModel.updateOne({ _id: 'demo' }, { $set: { lockedUntil: new Date(now.getTime() + HOUR), fails: [] } });
  await OtpTokenModel.updateMany({ audience: 'shop', email: DEMO_EMAIL, consumedAt: null }, { $set: { consumedAt: now } });
  logger.warn('Demo sign-in locked for an hour after 10 wrong codes');
  await signal('demo_locked', now);
}

export async function demoSignedIn() {
  await DemoModel.updateOne({ _id: 'demo' }, { $set: { fails: [] } });
}
