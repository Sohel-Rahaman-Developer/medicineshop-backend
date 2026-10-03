import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { generateOpaqueToken, newFamilyId, sha256 } from '../../utils/crypto';
import { UserModel } from '../user/user.model';
import { SessionModel, type SessionDoc } from './models/session.model';

/** Absolute cap — however far sliding expiry pushes, a login is required after this. */
const ABSOLUTE_MAX_DAYS = 180;

export interface AccessTokenPayload {
  sub: string;
  sid: string;
}

export function signAccessToken(userId: string, sessionId: string): { token: string; expiresInMs: number } {
  const token = jwt.sign({ sub: userId, sid: sessionId } satisfies AccessTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
  const decoded = jwt.decode(token);
  const exp = typeof decoded === 'object' && decoded?.exp ? decoded.exp * 1000 : Date.now();
  return { token, expiresInMs: Math.max(0, exp - Date.now()) };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof decoded === 'string' || !decoded.sub || !('sid' in decoded)) {
      throw AppError.unauthenticated('Invalid token');
    }
    return { sub: decoded.sub, sid: String(decoded.sid) };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // The frontend sees this and silently calls /auth/refresh.
      throw AppError.unauthenticated('Access token has expired');
    }
    if (err instanceof AppError) throw err;
    throw AppError.unauthenticated('Invalid token');
  }
}

export interface SessionContext {
  ip?: string;
  userAgent?: string;
  deviceInfo?: string;
  rememberMe: boolean;
}

function ttlDays(rememberMe: boolean): number {
  return rememberMe ? env.REFRESH_TTL_DAYS_REMEMBER : env.REFRESH_TTL_DAYS;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export interface IssuedTokens {
  accessToken: string;
  /** Cookie maxAge, so the access cookie dies with the JWT. */
  accessExpiresInMs: number;
  refreshToken: string;
  session: SessionDoc;
  refreshExpiresAt: Date;
}

export async function issueNewSession(userId: Types.ObjectId, ctx: SessionContext): Promise<IssuedTokens> {
  return createSession(userId, ctx, newFamilyId(), daysFromNow(ABSOLUTE_MAX_DAYS));
}

async function createSession(
  userId: Types.ObjectId,
  ctx: SessionContext,
  familyId: string,
  absoluteExpiresAt: Date,
): Promise<IssuedTokens> {
  const refreshToken = generateOpaqueToken();
  const expiresAt = daysFromNow(ttlDays(ctx.rememberMe));

  const session = await SessionModel.create({
    userId,
    tokenHash: sha256(refreshToken),
    familyId,
    rememberMe: ctx.rememberMe,
    deviceInfo: ctx.deviceInfo ?? '',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    lastUsedAt: new Date(),
    expiresAt,
    // The family's absolute cap carries forward on rotation.
    absoluteExpiresAt,
  });

  const access = signAccessToken(userId.toString(), session.id);
  return {
    accessToken: access.token,
    accessExpiresInMs: access.expiresInMs,
    refreshToken,
    session,
    refreshExpiresAt: expiresAt,
  };
}

export async function rotateRefreshToken(
  rawToken: string,
  ctx: Omit<SessionContext, 'rememberMe'>,
  opts: { unlocked?: boolean } = {},
): Promise<IssuedTokens & { reuseDetected?: boolean }> {
  const session = await SessionModel.findOne({ tokenHash: sha256(rawToken) });

  // Not in the database at all — wrong, made up, or old enough that TTL removed it.
  if (!session) throw AppError.unauthenticated('This session is no longer valid, please sign in again');

  // Spent token presented again = leaked chain: revoke the whole family.
  if (session.usedAt) {
    await revokeFamily(session.familyId, 'reuse_detected');
    const err = AppError.unauthenticated('All sessions were closed for your security. Please sign in again.');
    // The caller needs to know so it can send the user an alert email.
    (err as AppError & { reuseDetected?: boolean; session?: SessionDoc }).reuseDetected = true;
    (err as AppError & { session?: SessionDoc }).session = session;
    throw err;
  }

  if (session.revokedAt) throw AppError.unauthenticated('This session was closed, please sign in again');
  if (session.expiresAt.getTime() < Date.now()) throw AppError.unauthenticated('This session has expired, please sign in again');
  if (session.absoluteExpiresAt.getTime() < Date.now()) {
    throw AppError.unauthenticated('Please sign in again for your security');
  }

  // A user disabled by the platform loses every session at the next refresh.
  const owner = await UserModel.findById(session.userId).select('status pinHash lockMinutes').lean();
  if (!owner || owner.status === 'disabled') {
    await revokeFamily(session.familyId, 'disabled');
    throw AppError.unauthenticated('This account is not active. Please contact support.');
  }
  // D60: idle past the lock time with a PIN set → the PIN, not a refresh. An active user refreshes every 15 minutes.
  if (!opts.unlocked && owner.pinHash && Date.now() - session.lastUsedAt.getTime() > owner.lockMinutes * 60_000) throw AppError.locked();

  session.usedAt = new Date();
  session.revokedAt = new Date();
  session.revokedReason = 'rotated';
  await session.save();

  return createSession(
    session.userId,
    { ...ctx, rememberMe: session.rememberMe, deviceInfo: session.deviceInfo || ctx.deviceInfo },
    session.familyId,
    session.absoluteExpiresAt,
  );
}

export async function revokeFamily(familyId: string, reason: SessionDoc['revokedReason']): Promise<number> {
  const res = await SessionModel.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
}

export async function revokeSessionById(sessionId: string, reason: SessionDoc['revokedReason']): Promise<void> {
  await SessionModel.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function revokeByRefreshToken(rawToken: string, reason: SessionDoc['revokedReason']): Promise<void> {
  await SessionModel.updateOne(
    { tokenHash: sha256(rawToken), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function revokeAllForUser(userId: Types.ObjectId | string, reason: SessionDoc['revokedReason']): Promise<number> {
  const res = await SessionModel.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
}

export async function listActiveSessions(userId: Types.ObjectId | string) {
  return SessionModel.find({
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastUsedAt: -1 })
    .select('deviceInfo ip userAgent lastUsedAt createdAt expiresAt')
    .lean();
}
