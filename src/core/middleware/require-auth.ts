// requireAuth — verifies the access token from the httpOnly `ms_at` cookie.
import type { RequestHandler } from 'express';
import { readCookie } from '../cookies';
import { AppError } from '../errors';
import { verifyAccessToken } from '../../modules/auth/token.service';
import { ACCESS_COOKIE } from '../../modules/auth/auth.cookies';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; sessionId: string };
    }
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readCookie(req, ACCESS_COOKIE);
  if (!token) return next(AppError.unauthenticated('Please sign in to continue'));

  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, sessionId: payload.sid };
    next();
  } catch (err) {
    next(err);
  }
};

/** Auth is optional — attach it when a valid token is present, otherwise carry on. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = readCookie(req, ACCESS_COOKIE);
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, sessionId: payload.sid };
  } catch {
    // Ignore a bad token — this endpoint is public.
  }
  next();
};
