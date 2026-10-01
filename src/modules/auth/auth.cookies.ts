// Auth cookies (PLAN D35).
import type { CookieOptions, Response } from 'express';
import { env } from '../../config/env';
import type { IssuedTokens } from './token.service';

export const ACCESS_COOKIE = 'ms_at';
export const REFRESH_COOKIE = 'ms_rt';

function base(path: string): CookieOptions {
  return { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path };
}

const accessOptions = (): CookieOptions => base(env.API_PREFIX);
// The refresh token is only ever needed by /auth/refresh and /auth/logout.
const refreshOptions = (): CookieOptions => base(`${env.API_PREFIX}/auth`);

export function setAuthCookies(res: Response, tokens: IssuedTokens): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...accessOptions(), maxAge: tokens.accessExpiresInMs });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...refreshOptions(), expires: tokens.refreshExpiresAt });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, accessOptions());
  res.clearCookie(REFRESH_COOKIE, refreshOptions());
}
