import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { readCookie } from '../../core/cookies';
import { AppError } from '../../core/errors';
import { sendMail } from '../../services/mailer';
import { adminOtpEmail } from '../../services/email-templates';
import { compareOtp, generateNumericOtp, generateOpaqueToken, hashOtp, sha256 } from '../../utils/crypto';
import { checkTotp, newTotpSecret, open, otpauthUrl, seal } from '../../utils/totp';
import { OtpTokenModel } from '../auth/models/otp-token.model';
import { AdminSessionModel, AdminUserModel, type AdminRole } from './admin.model';

// SECURITY §3: the admin signs in with an email code AND an authenticator code, on its own cookie, for 8 hours at most.
export const ADMIN_COOKIE = 'ms_adm';
export const ADMIN_PRE_COOKIE = 'ms_adm_pre';
const FULL_MS = 8 * 60 * 60 * 1000;
const PRE_MS = 10 * 60 * 1000;
const TOTP_TRIES = 5;

const cookie = (): CookieOptions => ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path: `${env.API_PREFIX}/admin` });
const totpKey = () => env.ADMIN_TOTP_KEY ?? env.JWT_ACCESS_SECRET;

export interface AdminActor {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminActor;
    }
  }
}

/** Same answer whether or not the address is a platform admin — nothing about the team leaks. */
export async function requestCode(rawEmail: string, ip?: string) {
  const email = rawEmail.toLowerCase().trim();
  const admin = await AdminUserModel.findOne({ email, status: 'active' }).select('_id').lean();
  if (!admin) {
    logger.warn({ email }, 'Admin code asked for a non-admin address');
    return { expiresInMinutes: env.OTP_TTL_MINUTES };
  }
  await OtpTokenModel.updateMany({ audience: 'admin', email, consumedAt: null }, { $set: { consumedAt: new Date() } });
  const otp = env.DEV_STATIC_OTP ?? generateNumericOtp(env.OTP_LENGTH);
  await OtpTokenModel.create({ email, otpHash: await hashOtp(otp), audience: 'admin', maxAttempts: env.OTP_MAX_ATTEMPTS, expiresAt: new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000), ip });
  await sendMail({ to: email, ...adminOtpEmail(otp, env.OTP_TTL_MINUTES) });
  return { expiresInMinutes: env.OTP_TTL_MINUTES };
}

async function newSession(adminUserId: Types.ObjectId, stage: 'pre' | 'full', req: Request, extra: { setupSecretEnc?: string } = {}) {
  const token = generateOpaqueToken();
  await AdminSessionModel.create({ adminUserId, tokenHash: sha256(token), stage, expiresAt: new Date(Date.now() + (stage === 'full' ? FULL_MS : PRE_MS)), ip: req.ip, userAgent: req.get('user-agent'), ...extra });
  return token;
}

/** Step 1 → 2: the email code is right; a 10-minute pre-session waits for the authenticator. First time: set it up. */
export async function verifyCode(req: Request, res: Response, rawEmail: string, otp: string) {
  const email = rawEmail.toLowerCase().trim();
  const invalid = () => AppError.unauthenticated('That code is wrong or has expired');
  const token = await OtpTokenModel.findOne({ audience: 'admin', email, consumedAt: null }).sort({ createdAt: -1 });
  if (!token || token.expiresAt.getTime() < Date.now()) throw invalid();
  if (token.attempts >= token.maxAttempts) throw AppError.unauthenticated('Too many wrong attempts. Please request a new code.');
  if (!(await compareOtp(otp, token.otpHash))) {
    await OtpTokenModel.updateOne({ _id: token._id }, { $inc: { attempts: 1 } });
    throw invalid();
  }
  const consumed = await OtpTokenModel.findOneAndUpdate({ _id: token._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!consumed) throw invalid();
  const admin = await AdminUserModel.findOne({ email, status: 'active' });
  if (!admin) throw invalid();
  const setup = !admin.totpEnabledAt;
  const secret = setup ? newTotpSecret() : null;
  const pre = await newSession(admin._id, 'pre', req, secret ? { setupSecretEnc: seal(secret, totpKey()) } : {});
  res.cookie(ADMIN_PRE_COOKIE, pre, { ...cookie(), maxAge: PRE_MS });
  return secret ? { stage: 'setup' as const, secret, otpauthUrl: otpauthUrl(secret, email) } : { stage: 'totp' as const };
}

/** Step 2: the authenticator code. Only now is there a real admin session; a used step never works again. */
export async function verifyTotp(req: Request, res: Response, code: string) {
  const raw = readCookie(req, ADMIN_PRE_COOKIE);
  const pre = raw ? await AdminSessionModel.findOne({ tokenHash: sha256(raw), stage: 'pre', revokedAt: null }) : null;
  if (!pre || pre.expiresAt.getTime() < Date.now()) throw AppError.unauthenticated('Start again with your email code');
  if (pre.attempts >= TOTP_TRIES) throw AppError.unauthenticated('Too many wrong codes. Start again with your email code.');
  const admin = await AdminUserModel.findOne({ _id: pre.adminUserId, status: 'active' });
  if (!admin) throw AppError.unauthenticated('Start again with your email code');
  const sealed = pre.setupSecretEnc ?? admin.totpSecretEnc;
  if (!sealed) throw AppError.unauthenticated('Start again with your email code');
  const secret = open(sealed, totpKey());
  const step = checkTotp(secret, code);
  if (step === null || step <= admin.totpLastStep) {
    await AdminSessionModel.updateOne({ _id: pre._id }, { $inc: { attempts: 1 } });
    throw AppError.unauthenticated('That authenticator code is wrong');
  }
  if (pre.setupSecretEnc) admin.set({ totpSecretEnc: pre.setupSecretEnc, totpEnabledAt: new Date() });
  admin.set({ totpLastStep: step, lastLoginAt: new Date() });
  await admin.save();
  await AdminSessionModel.updateOne({ _id: pre._id }, { $set: { revokedAt: new Date() } });
  const full = await newSession(admin._id, 'full', req);
  res.clearCookie(ADMIN_PRE_COOKIE, cookie());
  res.cookie(ADMIN_COOKIE, full, { ...cookie(), maxAge: FULL_MS });
  logger.info({ adminId: String(admin._id) }, 'Admin signed in');
  return { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role };
}

export async function signOut(req: Request, res: Response) {
  const raw = readCookie(req, ADMIN_COOKIE);
  if (raw) await AdminSessionModel.updateOne({ tokenHash: sha256(raw) }, { $set: { revokedAt: new Date() } });
  res.clearCookie(ADMIN_COOKIE, cookie());
}

/** Every /admin route but sign-in: a live full session of an active admin. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  void (async () => {
    const raw = readCookie(req, ADMIN_COOKIE);
    if (!raw) throw AppError.unauthenticated('Please sign in to MedShop Admin');
    const s = await AdminSessionModel.findOne({ tokenHash: sha256(raw), stage: 'full', revokedAt: null }).lean();
    if (!s || s.expiresAt.getTime() < Date.now()) throw AppError.unauthenticated('Your admin session has ended — sign in again');
    const a = await AdminUserModel.findOne({ _id: s.adminUserId, status: 'active' }).lean();
    if (!a?.totpEnabledAt) throw AppError.unauthenticated('Please sign in to MedShop Admin');
    req.admin = { id: String(a._id), name: a.name, email: a.email, role: a.role };
  })().then(() => { next(); }, next);
};

export const requireAdminRole =
  (...roles: AdminRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      next(AppError.forbidden('Your admin role can’t do this'));
      return;
    }
    next();
  };

export const adminOf = (req: Request): AdminActor => {
  if (!req.admin) throw AppError.unauthenticated();
  return req.admin;
};
