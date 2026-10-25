import bcrypt from 'bcryptjs';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import type { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { readCookie } from '../../core/cookies';
import { AppError } from '../../core/errors';
import { fieldOtpEmail } from '../../services/email-templates';
import type { Lang } from '../../core/lang';
import { sendMail } from '../../services/mailer';
import { compareOtp, generateNumericOtp, generateOpaqueToken, hashOtp, sha256 } from '../../utils/crypto';
import { OtpTokenModel } from '../auth/models/otp-token.model';
import { FieldSessionModel, FieldStaffModel } from './field.model';

// D100: field staff sign in with a password or an email code — their choice, no authenticator — and stay signed in
// for 7 days so email codes are not spent every day. Their own cookie, path and routes: never the admin console.
export const FIELD_COOKIE = 'ms_fld';
const SESSION_MS = 7 * 86_400_000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

const cookie = (): CookieOptions => ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path: `${env.API_PREFIX}/field` });

export interface FieldActor {
  id: string;
  name: string;
  email: string;
  code: string;
  sessionId: string;
  method: 'password' | 'otp';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      field?: FieldActor;
    }
  }
}

const wrong = () => AppError.unauthenticated('Email or password is wrong — or sign in with an email code');

/** Same answer whether or not the address is field staff. */
export async function requestCode(rawEmail: string, ip?: string, lang: Lang = 'en') {
  const email = rawEmail.toLowerCase().trim();
  const staff = await FieldStaffModel.findOne({ email, status: 'active' }).select('_id').lean();
  if (!staff) {
    logger.warn({ email }, 'Field code asked for a non-staff address');
    return { expiresInMinutes: env.OTP_TTL_MINUTES };
  }
  await OtpTokenModel.updateMany({ audience: 'field', email, consumedAt: null }, { $set: { consumedAt: new Date() } });
  const otp = env.DEV_STATIC_OTP ?? generateNumericOtp(env.OTP_LENGTH);
  await OtpTokenModel.create({ email, otpHash: await hashOtp(otp), audience: 'field', maxAttempts: env.OTP_MAX_ATTEMPTS, expiresAt: new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000), ip });
  await sendMail({ to: email, ...fieldOtpEmail(otp, env.OTP_TTL_MINUTES, lang) });
  return { expiresInMinutes: env.OTP_TTL_MINUTES };
}

async function startSession(req: Request, res: Response, staffId: Types.ObjectId, method: 'password' | 'otp') {
  const token = generateOpaqueToken();
  await FieldSessionModel.create({ staffId, tokenHash: sha256(token), method, expiresAt: new Date(Date.now() + SESSION_MS), ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) });
  await FieldStaffModel.updateOne({ _id: staffId }, { $set: { lastLoginAt: new Date(), failedLogins: 0 }, $unset: { lockedUntil: '' } });
  res.cookie(FIELD_COOKIE, token, { ...cookie(), maxAge: SESSION_MS });
  return me(staffId);
}

export async function verifyCode(req: Request, res: Response, rawEmail: string, otp: string) {
  const email = rawEmail.toLowerCase().trim();
  const invalid = () => AppError.unauthenticated('That code is wrong or has expired');
  const token = await OtpTokenModel.findOne({ audience: 'field', email, consumedAt: null }).sort({ createdAt: -1 });
  if (!token || token.expiresAt.getTime() < Date.now()) throw invalid();
  if (token.attempts >= token.maxAttempts) throw AppError.unauthenticated('Too many wrong attempts. Please request a new code.');
  if (!(await compareOtp(otp, token.otpHash))) {
    await OtpTokenModel.updateOne({ _id: token._id }, { $inc: { attempts: 1 } });
    throw invalid();
  }
  const consumed = await OtpTokenModel.findOneAndUpdate({ _id: token._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!consumed) throw invalid();
  const staff = await FieldStaffModel.findOne({ email, status: 'active' }).select('_id').lean();
  if (!staff) throw invalid();
  return startSession(req, res, staff._id, 'otp');
}

/** Five wrong passwords lock the password for 15 minutes; an email code still works. */
export async function passwordLogin(req: Request, res: Response, rawEmail: string, password: string) {
  const email = rawEmail.toLowerCase().trim();
  const staff = await FieldStaffModel.findOne({ email, status: 'active' });
  if (!staff?.passwordHash) throw wrong();
  if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) throw AppError.unauthenticated('Too many wrong passwords — wait 15 minutes, or sign in with an email code');
  if (!(await bcrypt.compare(password, staff.passwordHash))) {
    const failed = staff.failedLogins + 1;
    await FieldStaffModel.updateOne({ _id: staff._id }, { $set: { failedLogins: failed, ...(failed >= LOCK_AFTER ? { lockedUntil: new Date(Date.now() + LOCK_MS) } : {}) } });
    throw wrong();
  }
  return startSession(req, res, staff._id, 'password');
}

export async function me(staffId: Types.ObjectId | string) {
  const s = await FieldStaffModel.findById(staffId).select('name email phone code passwordHash').lean();
  if (!s) throw AppError.unauthenticated();
  return { id: String(s._id), name: s.name, email: s.email, phone: s.phone, code: s.code, hasPassword: Boolean(s.passwordHash) };
}

/** A first password after an email code; changing one needs the current password unless this session used a code. */
export async function setPassword(f: FieldActor, password: string, current?: string) {
  const staff = await FieldStaffModel.findById(f.id);
  if (!staff) throw AppError.unauthenticated();
  if (staff.passwordHash && f.method === 'password' && !(current && (await bcrypt.compare(current, staff.passwordHash)))) {
    throw AppError.validation('Your current password is wrong', [{ field: 'body.current', message: 'Wrong password' }]);
  }
  staff.set({ passwordHash: await bcrypt.hash(password, 12), failedLogins: 0, lockedUntil: undefined });
  await staff.save();
  await FieldSessionModel.updateMany({ staffId: staff._id, _id: { $ne: f.sessionId }, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function signOut(req: Request, res: Response) {
  const raw = readCookie(req, FIELD_COOKIE);
  if (raw) await FieldSessionModel.updateOne({ tokenHash: sha256(raw) }, { $set: { revokedAt: new Date() } });
  res.clearCookie(FIELD_COOKIE, cookie());
}

/** Every field route but sign-in: a live session of an active staff member. */
export const requireField: RequestHandler = (req, _res, next) => {
  void (async () => {
    const raw = readCookie(req, FIELD_COOKIE);
    if (!raw) throw AppError.unauthenticated('Please sign in');
    const s = await FieldSessionModel.findOne({ tokenHash: sha256(raw), revokedAt: null }).lean();
    if (!s || s.expiresAt.getTime() < Date.now()) throw AppError.unauthenticated('Your session has ended — sign in again');
    const staff = await FieldStaffModel.findOne({ _id: s.staffId, status: 'active' }).select('name email code').lean();
    if (!staff) throw AppError.unauthenticated('Please sign in');
    req.field = { id: String(staff._id), name: staff.name, email: staff.email, code: staff.code, sessionId: String(s._id), method: s.method };
  })().then(() => { next(); }, next);
};

export const fieldOf = (req: Request): FieldActor => {
  if (!req.field) throw AppError.unauthenticated();
  return req.field;
};
