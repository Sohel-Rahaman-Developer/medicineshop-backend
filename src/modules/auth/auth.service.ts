import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { otherShopAddress } from '../../core/origins';
import { sendMail } from '../../services/mailer';
import { otpEmail, sessionRevokedEmail } from '../../services/email-templates';
import type { Lang } from '../../core/lang';
import { signal } from '../../services/monitor';
import { compareOtp, generateNumericOtp, hashOtp, sha256 } from '../../utils/crypto';
import { MembershipModel } from '../memberships/membership.model';
import { UserModel, type UserDoc } from '../user/user.model';
import { demoFailed, demoSignedIn, demoToken } from '../demo/demo.login';
import { isDemoEmail } from '../demo/demo.model';
import { OtpTokenModel } from './models/otp-token.model';
import { SessionModel, type SessionDoc } from './models/session.model';
import {
  issueNewSession,
  rotateRefreshToken,
  type IssuedTokens,
  type SessionContext,
  revokeFamily,
} from './token.service';

export interface RequestContext {
  lang?: Lang;
  /** Signing in on a shop's own address: only that shop's people (active or invited). */
  onlyShop?: string | null;
  ip?: string;
  userAgent?: string;
  deviceInfo?: string;
}

export async function requestOtp(rawEmail: string, ctx: RequestContext): Promise<{ expiresInMinutes: number }> {
  const email = rawEmail.toLowerCase().trim();

  // Same response as success, so a disabled address is not revealed.
  const existing = await UserModel.findOne({ email }).select('status').lean();
  if (existing?.status === 'disabled') {
    logger.warn({ email }, 'Disabled user requested an OTP');
    return { expiresInMinutes: env.OTP_TTL_MINUTES };
  }

  if (isDemoEmail(email)) {
    await demoToken(email, ctx);
    return { expiresInMinutes: env.OTP_TTL_MINUTES };
  }

  // Invalidate older unconsumed OTPs so only one code is live at a time.
  await OtpTokenModel.updateMany(
    { audience: 'shop', email, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );

  // Development only (env refuses it elsewhere); attempts and rate limits still apply.
  const otp = env.DEV_STATIC_OTP ?? generateNumericOtp(env.OTP_LENGTH);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000);

  await OtpTokenModel.create({
    email,
    otpHash: await hashOtp(otp),
    audience: 'shop',
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    expiresAt,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  const mail = otpEmail(otp, env.OTP_TTL_MINUTES, ctx.lang);
  await sendMail({ to: email, ...mail });

  return { expiresInMinutes: env.OTP_TTL_MINUTES };
}

export interface VerifyResult {
  tokens: IssuedTokens;
  user: UserDoc;
  /** First ever login → the frontend routes them to onboarding. */
  isNewUser: boolean;
}

export async function verifyOtpAndLogin(rawEmail: string, otp: string, ctx: RequestContext & { rememberMe: boolean }): Promise<VerifyResult> {
  const email = rawEmail.toLowerCase().trim();
  if (!isDemoEmail(email)) return verify(email, otp, ctx);
  // Every failed try counts towards the demo lock, with or without a live code.
  return verify(email, otp, ctx).catch(async (err: unknown) => {
    if (err instanceof AppError && err.status === 401) await demoFailed();
    throw err;
  });
}

async function verify(email: string, otp: string, ctx: RequestContext & { rememberMe: boolean }): Promise<VerifyResult> {

  const token = await OtpTokenModel.findOne({ audience: 'shop', email, consumedAt: null }).sort({ createdAt: -1 });

  // One message for wrong, expired and missing codes.
  const invalid = () => AppError.unauthenticated('That code is wrong or has expired');

  if (!token) throw invalid();

  if (token.expiresAt.getTime() < Date.now()) {
    await OtpTokenModel.deleteOne({ _id: token._id });
    throw invalid();
  }

  if (token.attempts >= token.maxAttempts) {
    await OtpTokenModel.deleteOne({ _id: token._id });
    throw AppError.unauthenticated('Too many wrong attempts. Please request a new code.');
  }

  const ok = await compareOtp(otp, token.otpHash);

  if (!ok) {
    // Atomic increment, so ten simultaneous wrong guesses still count correctly.
    const updated = await OtpTokenModel.findOneAndUpdate(
      { _id: token._id },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (updated && updated.attempts >= updated.maxAttempts) {
      await OtpTokenModel.deleteOne({ _id: token._id });
    }
    await signal('login_fail');
    throw invalid();
  }

  // Atomic consume: two concurrent verifies cannot both create a session.
  const consumed = await OtpTokenModel.findOneAndUpdate(
    { _id: token._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!consumed) throw invalid(); // another request consumed it first
  if (isDemoEmail(email)) await demoSignedIn();

  // Find or create the user.
  const now = new Date();
  const before = await UserModel.findOne({ email }).select('emailVerifiedAt status').lean();
  if (before?.status === 'disabled') throw invalid();
  if (ctx.onlyShop && !(before && (await MembershipModel.exists({ shopId: new Types.ObjectId(ctx.onlyShop), userId: before._id, status: { $in: ['active', 'invited'] } })))) {
    throw otherShopAddress();
  }
  const isNewUser = !before?.emailVerifiedAt;

  const user = await UserModel.findOneAndUpdate(
    { email },
    {
      $set: { lastLoginAt: now, ...(isNewUser ? { emailVerifiedAt: now } : {}) },
      $setOnInsert: { email, name: '' },
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  );

  const sessionCtx: SessionContext = {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    deviceInfo: ctx.deviceInfo,
    rememberMe: ctx.rememberMe,
  };

  const tokens = await issueNewSession(user._id, sessionCtx);

  logger.info({ userId: user.id, isNewUser }, 'Login successful');

  return { tokens, user, isNewUser };
}

export async function refresh(rawToken: string, ctx: RequestContext): Promise<IssuedTokens> {
  try {
    return await rotateRefreshToken(rawToken, ctx);
  } catch (err) {
    // Reuse alert email; the family is already revoked even if mail fails.
    const e = err as AppError & { reuseDetected?: boolean; session?: SessionDoc };
    if (e.reuseDetected && e.session) {
      void notifyReuse(e.session).catch((mailErr: unknown) => {
        logger.error({ err: mailErr }, 'Reuse alert email failed');
      });
    }
    throw err;
  }
}

const PIN_TRIES = 5;

/** D60: right PIN → a fresh session; the 5th wrong one ends this device's session family. */
export async function unlock(rawToken: string, pin: string, ctx: RequestContext): Promise<IssuedTokens> {
  const session = await SessionModel.findOne({ tokenHash: sha256(rawToken), usedAt: null, revokedAt: null }).lean();
  if (!session || session.expiresAt.getTime() < Date.now()) throw AppError.unauthenticated('This session has ended — sign in with your email code');
  const user = await UserModel.findById(session.userId).select('pinHash pinFails status').lean();
  if (!user?.pinHash || user.status === 'disabled') throw AppError.unauthenticated('Sign in with your email code');
  if (!(await compareOtp(pin, user.pinHash))) {
    const after = await UserModel.findOneAndUpdate({ _id: user._id }, { $inc: { pinFails: 1 } }, { returnDocument: 'after' }).lean();
    if ((after?.pinFails ?? 0) >= PIN_TRIES) {
      await revokeFamily(session.familyId, 'user_revoked');
      await UserModel.updateOne({ _id: user._id }, { $set: { pinFails: 0 } });
      throw AppError.unauthenticated('Too many wrong PINs — sign in with your email code');
    }
    throw AppError.validation(`Wrong PIN — ${String(PIN_TRIES - (after?.pinFails ?? 0))} tries left`, [{ field: 'body.pin', message: 'Wrong PIN' }]);
  }
  await UserModel.updateOne({ _id: user._id }, { $set: { pinFails: 0 } });
  return rotateRefreshToken(rawToken, ctx, { unlocked: true });
}

async function notifyReuse(session: SessionDoc): Promise<void> {
  const user = await UserModel.findById(session.userId).select('email lang').lean();
  if (!user) return;
  logger.warn({ userId: String(session.userId), familyId: session.familyId }, '🚨 Refresh token reuse detected');
  const mail = sessionRevokedEmail(session.deviceInfo || 'unknown device', new Date(), user.lang ?? 'en');
  await sendMail({ to: user.email, ...mail });
}
