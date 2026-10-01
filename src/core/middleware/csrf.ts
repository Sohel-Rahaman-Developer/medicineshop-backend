// CSRF defence for cookie auth (SECURITY.md §4).
import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { allowedOrigins, env } from '../../config/env';
import { readCookie } from '../cookies';
import { AppError } from '../errors';

export const CSRF_COOKIE = 'ms_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sign(nonce: string): string {
  return crypto.createHmac('sha256', env.CSRF_SECRET).update(nonce).digest('base64url');
}

function isWellSigned(token: string): boolean {
  const [nonce, mac] = token.split('.');
  if (!nonce || !mac) return false;
  return safeEqual(mac, sign(nonce));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Reuses a valid cookie token so several tabs share one value. */
export function issueCsrfToken(req: Request, res: Response): string {
  const current = readCookie(req, CSRF_COOKIE);
  const token =
    current && isWellSigned(current)
      ? current
      : (() => {
          const nonce = crypto.randomBytes(32).toString('base64url');
          return `${nonce}.${sign(nonce)}`;
        })();
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: env.API_PREFIX,
  });
  return token;
}

export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (!origin || !allowedOrigins.includes(origin)) {
    return next(AppError.csrf('This request did not come from a MedShop app'));
  }

  const header = req.get(CSRF_HEADER);
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!header || !cookie || !safeEqual(header, cookie) || !isWellSigned(cookie)) {
    return next(AppError.csrf());
  }
  next();
};
