/**
 * requireAuth — verifies the access token from the Authorization header.
 *
 * There is no database hit here. The JWT is self-contained, so this middleware
 * is O(1) and puts no load on the database as traffic grows. Tenant and
 * permission checks live in separate middleware (Phase 2).
 */
import type { RequestHandler } from 'express';
import { AppError } from '../errors';
import { verifyAccessToken } from '../../modules/auth/token.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; sessionId: string };
    }
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return next(AppError.unauthenticated('An access token is required'));
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) return next(AppError.unauthenticated('The access token is empty'));

  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, sessionId: payload.sid };
    next();
  } catch (err) {
    next(err);
  }
};

/** Auth is optional — attach it when a token is present, otherwise carry on. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();
  try {
    const payload = verifyAccessToken(header.slice('Bearer '.length).trim());
    req.auth = { userId: payload.sub, sessionId: payload.sid };
  } catch {
    // Ignore a bad token — this endpoint is public.
  }
  next();
};
