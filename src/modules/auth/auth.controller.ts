import type { Request, Response } from 'express';
import { readCookie } from '../../core/cookies';
import { AppError } from '../../core/errors';
import { issueCsrfToken } from '../../core/middleware/csrf';
import { fetched, sent } from '../../core/response';
import { UserModel } from '../user/user.model';
import * as authService from './auth.service';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './auth.cookies';
import { listActiveSessions, revokeAllForUser, revokeByRefreshToken, revokeSessionById } from './token.service';
import type { LogoutInput, RequestOtpInput, VerifyOtpInput } from './auth.validation';

function ctxOf(req: Request) {
  return {
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
  });

  setAuthCookies(res, tokens);

  // A new user gets a different message — the frontend does not decide this.
  sent(
    res,
    {
      user: { id: user.id, email: user.email, name: user.name, status: user.status },
      isNewUser,
      // B1: memberships, so the frontend can show a shop picker.
      memberships: [],
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
    // A dead refresh token must not linger in the browser.
    clearAuthCookies(res);
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

  const user = await UserModel.findById(req.auth.userId).select('email name phone avatar status lastLoginAt').lean();
  if (!user) throw AppError.notFound('User not found');

  // A read — no message, otherwise every page load fires a pointless toast.
  fetched(res, {
    user: { id: String(user._id), ...user, _id: undefined },
    // B1: memberships + effective permissions.
    memberships: [],
    permissions: [],
  });
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
