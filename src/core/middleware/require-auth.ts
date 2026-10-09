// requireAuth — verifies the access token from the httpOnly `ms_at` cookie.
import type { Request, RequestHandler } from 'express';
import { readCookie } from '../cookies';
import { AppError } from '../errors';
import { verifyAccessToken } from '../../modules/auth/token.service';
import { ACCESS_COOKIE } from '../../modules/auth/auth.cookies';
import { SessionModel } from '../../modules/auth/models/session.model';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; sessionId: string };
    }
  }
}

/** The signed claims of the access cookie; throws when it is missing or does not verify. */
export function claimsOf(req: Request): { sub: string; sid: string } {
  const token = readCookie(req, ACCESS_COOKIE);
  if (!token) throw AppError.unauthenticated('Please sign in to continue');
  return verifyAccessToken(token);
}

// One indexed read per request so sign-out, suspension and removal take effect at once, not after 15 minutes.
export async function checkSession(claims: { sub: string; sid: string }): Promise<void> {
  const live = await SessionModel.exists({ _id: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!live) throw AppError.unauthenticated('This session has ended. Please sign in again.');
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  let claims: { sub: string; sid: string };
  try {
    claims = claimsOf(req);
  } catch (err) {
    return next(err);
  }
  checkSession(claims)
    .then(() => {
      req.auth = { userId: claims.sub, sessionId: claims.sid };
      next();
    })
    .catch(next);
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
