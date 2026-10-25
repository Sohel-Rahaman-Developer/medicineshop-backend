import type { Request, Response } from 'express';
import { readCookie } from '../../core/cookies';
import { AppError } from '../../core/errors';
import { originShop } from '../../core/origins';
import { issueCsrfToken } from '../../core/middleware/csrf';
import { fetched, sent } from '../../core/response';
import { langOf, type Lang } from '../../core/lang';
import { Types } from 'mongoose';
import { myInvitations, myShops } from '../memberships/memberships.service';
import { liveAddresses } from '../webaddress/web-address.service';
import { hashOtp } from '../../utils/crypto';
import { UserModel } from '../user/user.model';
import * as authService from './auth.service';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './auth.cookies';
import { listActiveSessions, revokeAllForUser, revokeByRefreshToken, revokeSessionById } from './token.service';
import type { LogoutInput, RequestOtpInput, UpdateMeInput, VerifyOtpInput } from './auth.validation';

function ctxOf(req: Request) {
  return {
    lang: langOf(req),
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
    deviceInfo: (req.body as { deviceInfo?: string } | undefined)?.deviceInfo,
  };
}

const refreshTokenOf = (req: Request) => readCookie(req, REFRESH_COOKIE);

export function csrf(req: Request, res: Response) {
  fetched(res, { csrfToken: issueCsrfToken(req, res) });
}

export async function requestOtp(req: Request, res: Response) {
  const { email } = req.body as RequestOtpInput;
  const result = await authService.requestOtp(email, ctxOf(req));

  // Always the same response — we never reveal whether the email exists.
  sent(res, { expiresInMinutes: result.expiresInMinutes }, 'If that email is valid, we have sent a code to it.');
}

export async function verifyOtp(req: Request, res: Response) {
  const { email, otp, rememberMe } = req.body as VerifyOtpInput;

  const { tokens, user, isNewUser } = await authService.verifyOtpAndLogin(email, otp, {
    ...ctxOf(req),
    rememberMe,
    onlyShop: await originShop(req.get('origin')),
  });

  setAuthCookies(res, tokens);

  // A new user gets a different message — the frontend does not decide this.
  sent(
    res,
    {
      user: { id: user.id, email: user.email, name: user.name, status: user.status },
      isNewUser,
    },
    isNewUser ? 'Welcome! Let us set up your shop.' : 'Signed in',
  );
}

export async function refresh(req: Request, res: Response) {
  const raw = refreshTokenOf(req);
  if (!raw) throw AppError.unauthenticated('Please sign in to continue');

  try {
    setAuthCookies(res, await authService.refresh(raw, ctxOf(req)));
  } catch (err) {
    // A dead refresh token must not linger in the browser; a locked one stays for the PIN (D60).
    if (!(err instanceof AppError && err.code === 'LOCKED')) clearAuthCookies(res);
    throw err;
  }

  sent(res, null, 'Session refreshed');
}

export async function logout(req: Request, res: Response) {
  const { allDevices } = req.body as LogoutInput;
  const raw = refreshTokenOf(req);

  if (allDevices) {
    if (!req.auth) throw AppError.unauthenticated('Sign in first to sign out of every device');
    await revokeAllForUser(req.auth.userId, 'logout_all');
  } else if (raw) {
    await revokeByRefreshToken(raw, 'logout');
  } else if (req.auth) {
    await revokeSessionById(req.auth.sessionId, 'logout');
  }

  clearAuthCookies(res);
  sent(res, null, allDevices ? 'Signed out of every device' : 'Signed out');
}

export async function me(req: Request, res: Response) {
  if (!req.auth) throw AppError.unauthenticated();

  const [user, shops, invitations] = await Promise.all([
    UserModel.findById(req.auth.userId).select('email name phone avatar status lastLoginAt pinHash lockMinutes lang').lean(),
    myShops(req.auth.userId),
    myInvitations(req.auth.userId),
  ]);
  if (!user) throw AppError.notFound('User not found');
  // D94: a shop with its own live address is opened there.
  const addresses = await liveAddresses(shops.map((s) => new Types.ObjectId(s.shopId)));

  // A read — no message, otherwise every page load fires a pointless toast.
  fetched(res, {
    user: { id: String(user._id), email: user.email, name: user.name, phone: user.phone, status: user.status, hasPin: Boolean(user.pinHash), lockMinutes: user.lockMinutes, lang: user.lang ?? null },
    shops: shops.map((s) => ({ ...s, address: addresses.get(s.shopId) ?? null })),
    invitations: invitations.length,
  });
}

/** D60: the PIN opens an idle session on this device; 5 wrong and the session ends (email code again). */
export async function unlock(req: Request, res: Response) {
  const raw = refreshTokenOf(req);
  if (!raw) throw AppError.unauthenticated('Please sign in to continue');
  try {
    setAuthCookies(res, await authService.unlock(raw, (req.body as { pin: string }).pin, ctxOf(req)));
  } catch (err) {
    if (err instanceof AppError && err.code === 'UNAUTHENTICATED') clearAuthCookies(res);
    throw err;
  }
  sent(res, null, 'Unlocked');
}

export async function setPin(req: Request, res: Response) {
  if (!req.auth) throw AppError.unauthenticated();
  const { pin, lockMinutes } = req.body as { pin: string; lockMinutes: number };
  await UserModel.updateOne({ _id: req.auth.userId }, { $set: { pinHash: await hashOtp(pin), pinSetAt: new Date(), lockMinutes, pinFails: 0 } });
  sent(res, { hasPin: true, lockMinutes }, `PIN saved — this device locks after ${String(lockMinutes)} idle minutes`);
}

export async function removePin(req: Request, res: Response) {
  if (!req.auth) throw AppError.unauthenticated();
  await UserModel.updateOne({ _id: req.auth.userId }, { $unset: { pinHash: 1, pinSetAt: 1 }, $set: { pinFails: 0 } });
  sent(res, { hasPin: false }, 'PIN removed');
}

export async function updateMe(req: Request, res: Response) {
  if (!req.auth) throw AppError.unauthenticated();
  const { name, phone } = req.body as UpdateMeInput;
  await UserModel.updateOne({ _id: req.auth.userId }, phone ? { $set: { name, phone } } : { $set: { name }, $unset: { phone: 1 } });
  sent(res, null, 'Profile saved');
}

/** The language picked in My account / Settings, kept for the emails; the app itself reads its own copy. */
export async function setLang(req: Request, res: Response) {
  if (!req.auth) throw AppError.unauthenticated();
  const { lang } = req.body as { lang: Lang };
  await UserModel.updateOne({ _id: req.auth.userId }, { $set: { lang } });
  fetched(res, { lang });
}

export async function sessions(req: Request, res: Response) {
  if (!req.auth) throw AppError.unauthenticated();

  const rows = await listActiveSessions(req.auth.userId);

  fetched(
    res,
    rows.map((s) => ({
      id: String(s._id),
      deviceInfo: s.deviceInfo,
      ip: s.ip,
      userAgent: s.userAgent,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      current: String(s._id) === req.auth?.sessionId,
    })),
  );
}

export async function revokeSession(req: Request, res: Response) {
  if (!req.auth) throw AppError.unauthenticated();

  const { id } = req.params as { id: string };

  // Ownership check, so nobody can revoke another user's session.
  const own = await listActiveSessions(req.auth.userId);
  if (!own.some((s) => String(s._id) === id)) throw AppError.notFound('Session not found');

  await revokeSessionById(id, 'user_revoked');
  sent(res, null, 'That device has been signed out');
}
