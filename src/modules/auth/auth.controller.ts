/**
 * Auth controllers — HTTP plumbing only: read the input, call the service,
 * send the response. No business logic belongs here.
 */
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { fetched, sent } from '../../core/response';
import { UserModel } from '../user/user.model';
import * as authService from './auth.service';
import {
  listActiveSessions,
  revokeAllForUser,
  revokeByRefreshToken,
  revokeSessionById,
  type IssuedTokens,
} from './token.service';
import type { LogoutInput, RefreshInput, RequestOtpInput, VerifyOtpInput } from './auth.validation';

const REFRESH_COOKIE = 'ms_rt';

function cookieOptions(expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN || undefined,
    // Scope the cookie to the auth routes only — sending it on every other API
    // call buys nothing and widens the exposure.
    path: `${env.API_PREFIX}/auth`,
    expires: expiresAt,
  };
}

function ctxOf(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
    deviceInfo: (req.body as { deviceInfo?: string } | undefined)?.deviceInfo,
  };
}

/**
 * Web gets the refresh token in a cookie, NOT in the body — otherwise the
 * whole point of httpOnly is lost. Native gets it in the body, because there
 * is no cookie jar there.
 */
function sendTokens(res: Response, tokens: IssuedTokens, client: 'web' | 'native', extra: object = {}) {
  const payload: Record<string, unknown> = {
    accessToken: tokens.accessToken,
    expiresIn: env.JWT_ACCESS_TTL,
    ...extra,
  };

  if (client === 'web') {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(tokens.refreshExpiresAt));
  } else {
    payload.refreshToken = tokens.refreshToken;
    payload.refreshExpiresAt = tokens.refreshExpiresAt;
  }

  return payload;
}

/* ------------------------------------------------------------------ */

export async function requestOtp(req: Request, res: Response) {
  const { email } = req.body as RequestOtpInput;
  const result = await authService.requestOtp(email, ctxOf(req));

  // Always the same response — we never reveal whether the email exists.
  sent(res, { expiresInMinutes: result.expiresInMinutes }, 'If that email is valid, we have sent a code to it.');
}

export async function verifyOtp(req: Request, res: Response) {
  const { email, otp, rememberMe, client } = req.body as VerifyOtpInput;

  const { tokens, user, isNewUser } = await authService.verifyOtpAndLogin(email, otp, {
    ...ctxOf(req),
    rememberMe,
  });

  const payload = sendTokens(res, tokens, client, {
    user: { id: user.id, email: user.email, name: user.name, status: user.status },
    isNewUser,
    // TODO Phase 2: send memberships so the frontend can show a shop picker.
    memberships: [],
  });

  // A new user gets a different message — the frontend does not decide this.
  sent(res, payload, isNewUser ? 'Welcome! Let us set up your shop.' : 'Signed in');
}

export async function refresh(req: Request, res: Response) {
  const { refreshToken: bodyToken, client } = req.body as RefreshInput;

  // Cookie on web, body on native. Both are supported.
  const raw = bodyToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);
  if (!raw) throw AppError.unauthenticated('No refresh token was provided');

  const tokens = await authService.refresh(raw, ctxOf(req));
  const payload = sendTokens(res, tokens, client);

  sent(res, payload, 'Session refreshed');
}

export async function logout(req: Request, res: Response) {
  const { refreshToken: bodyToken, allDevices } = req.body as LogoutInput;
  const raw = bodyToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);

  if (allDevices) {
    if (!req.auth) throw AppError.unauthenticated('Sign in first to sign out of every device');
    await revokeAllForUser(req.auth.userId, 'logout_all');
  } else if (raw) {
    await revokeByRefreshToken(raw, 'logout');
  } else if (req.auth) {
    await revokeSessionById(req.auth.sessionId, 'logout');
  }

  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(new Date()), expires: undefined });
  sent(res, null, allDevices ? 'Signed out of every device' : 'Signed out');
}

export async function me(req: Request, res: Response) {
  if (!req.auth) throw AppError.unauthenticated();

  const user = await UserModel.findById(req.auth.userId).select('email name phone avatar status lastLoginAt').lean();
  if (!user) throw AppError.notFound('User not found');

  // A read — no message, otherwise every page load fires a pointless toast.
  fetched(res, {
    user: { id: String(user._id), ...user, _id: undefined },
    // TODO Phase 2: memberships + effective permissions.
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
      /** Is this the device the request came from? */
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

  await revokeSessionById(id, 'admin_revoked');
  sent(res, null, 'That device has been signed out');
}
