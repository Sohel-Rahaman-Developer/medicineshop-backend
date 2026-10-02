import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../core/errors';
import { sendMail } from '../../services/mailer';
import { otpEmail, sessionRevokedEmail } from '../../services/email-templates';
import { compareOtp, generateNumericOtp, hashOtp } from '../../utils/crypto';
import { UserModel, type UserDoc } from '../user/user.model';
import { OtpTokenModel } from './models/otp-token.model';
import type { SessionDoc } from './models/session.model';
import {
  issueNewSession,
  rotateRefreshToken,
  type IssuedTokens,
  type SessionContext,
} from './token.service';

export interface RequestContext {
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

  const mail = otpEmail(otp, env.OTP_TTL_MINUTES);
  await sendMail({ to: email, ...mail });

  return { expiresInMinutes: env.OTP_TTL_MINUTES };
}

export interface VerifyResult {
  tokens: IssuedTokens;
  user: UserDoc;
  /** First ever login → the frontend routes them to onboarding. */
  isNewUser: boolean;
}

export async function verifyOtpAndLogin(
  rawEmail: string,
  otp: string,
  ctx: RequestContext & { rememberMe: boolean },
): Promise<VerifyResult> {
  const email = rawEmail.toLowerCase().trim();

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
    throw invalid();
  }

  // Atomic consume: two concurrent verifies cannot both create a session.
  const consumed = await OtpTokenModel.findOneAndUpdate(
    { _id: token._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!consumed) throw invalid(); // another request consumed it first

  // Find or create the user.
  const now = new Date();
  const before = await UserModel.findOne({ email }).select('emailVerifiedAt status').lean();
  if (before?.status === 'disabled') throw invalid();
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

async function notifyReuse(session: SessionDoc): Promise<void> {
  const user = await UserModel.findById(session.userId).select('email').lean();
  if (!user) return;
  logger.warn({ userId: String(session.userId), familyId: session.familyId }, '🚨 Refresh token reuse detected');
  const mail = sessionRevokedEmail(session.deviceInfo || 'unknown device', new Date());
  await sendMail({ to: user.email, ...mail });
}
