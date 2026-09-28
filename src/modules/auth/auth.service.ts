/**
 * Auth service — all the business logic behind email OTP login.
 *
 * Two things are the way they are on purpose:
 *
 * 1. Requesting an OTP always returns the same response, whether or not the
 *    email is registered. Otherwise anyone could use this endpoint to discover
 *    which addresses exist in the system (email enumeration).
 *
 * 2. Consuming an OTP is atomic. If two requests arrive with the same correct
 *    OTP at the same moment, only ONE login is created — because the update
 *    runs with a `consumedAt: null` filter, and that is a single-document
 *    atomic operation in MongoDB.
 */
import { Types } from 'mongoose';
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

/* ------------------------------------------------------------------ *
 * OTP request
 * ------------------------------------------------------------------ */

export async function requestOtp(rawEmail: string, ctx: RequestContext): Promise<{ expiresInMinutes: number }> {
  const email = rawEmail.toLowerCase().trim();

  // Do not send an OTP to a blocked user — but keep the response identical,
  // otherwise an attacker learns that this address exists and is blocked.
  const existing = await UserModel.findOne({ email }).select('status').lean();
  if (existing?.status === 'blocked') {
    logger.warn({ email }, 'Blocked user requested an OTP');
    return { expiresInMinutes: env.OTP_TTL_MINUTES };
  }

  // Invalidate older unconsumed OTPs so only one code is live at a time.
  await OtpTokenModel.updateMany(
    { email, purpose: 'login', consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );

  const otp = generateNumericOtp(env.OTP_LENGTH);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000);

  await OtpTokenModel.create({
    email,
    otpHash: await hashOtp(otp),
    purpose: 'login',
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    expiresAt,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  const mail = otpEmail(otp, env.OTP_TTL_MINUTES);
  await sendMail({ to: email, ...mail });

  return { expiresInMinutes: env.OTP_TTL_MINUTES };
}

/* ------------------------------------------------------------------ *
 * OTP verify → login
 * ------------------------------------------------------------------ */

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

  const token = await OtpTokenModel.findOne({ email, purpose: 'login', consumedAt: null }).sort({ createdAt: -1 });

  // Every failure returns the same message. An attacker must not be able to
  // tell whether the OTP was wrong, expired, or never existed.
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

  // ✅ The code is correct. Consume it ATOMICALLY so two concurrent requests
  // cannot create two sessions. Whoever gets there first gets the document.
  const consumed = await OtpTokenModel.findOneAndUpdate(
    { _id: token._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!consumed) throw invalid(); // another request consumed it first

  // Find or create the user. The upsert is atomic, so two parallel first-time
  // logins still produce one user (the unique index on email backs this up).
  const now = new Date();
  const before = await UserModel.findOne({ email }).select('_id').lean();
  const isNewUser = !before;

  const user = await UserModel.findOneAndUpdate(
    { email },
    {
      $set: { lastLoginAt: now, status: 'active' },
      $setOnInsert: { email, name: '' },
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  );

  if (!user) throw AppError.internal('Could not create the user record');

  const sessionCtx: SessionContext = {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    deviceInfo: ctx.deviceInfo,
    rememberMe: ctx.rememberMe,
  };

  const tokens = await issueNewSession(user._id as Types.ObjectId, sessionCtx);

  logger.info({ userId: user.id, isNewUser }, 'Login successful');

  return { tokens, user, isNewUser };
}

/* ------------------------------------------------------------------ *
 * Refresh
 * ------------------------------------------------------------------ */

export async function refresh(rawToken: string, ctx: RequestContext): Promise<IssuedTokens> {
  try {
    return await rotateRefreshToken(rawToken, ctx);
  } catch (err) {
    // Reuse was detected — email the user. This is a security incident, and
    // the login stays blocked even if the email fails to send.
    const e = err as AppError & { reuseDetected?: boolean; session?: SessionDoc };
    if (e.reuseDetected && e.session) {
      void notifyReuse(e.session).catch((mailErr) => logger.error({ err: mailErr }, 'Reuse alert email failed'));
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
