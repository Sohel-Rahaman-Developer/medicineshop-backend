import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { sha256 } from '../../utils/crypto';
import { MembershipModel } from '../memberships/membership.model';
import { shopOfDomainOrigin } from '../owndomain/own-domain.service';
import { UserModel } from '../user/user.model';
import { HandoffModel } from './models/handoff.model';
import { SessionModel } from './models/session.model';
import { issueNewSession, type IssuedTokens, type SessionContext } from './token.service';

const TTL_MS = 60_000;

/** A code to open the person's own shop on its own domain, signed in. Only for a live domain of a shop they work in. */
export async function startHandoff(userId: string, sessionId: string, to: string, now = new Date()) {
  const origin = to.replace(/\/+$/, '');
  const shopId = await shopOfDomainOrigin(origin);
  const member = shopId ? await MembershipModel.exists({ shopId: new Types.ObjectId(shopId), userId: new Types.ObjectId(userId), status: 'active' }) : null;
  if (!member) throw AppError.forbidden('This domain is not one of your shops');
  const session = await SessionModel.findById(sessionId).select('rememberMe').lean();
  const code = randomBytes(32).toString('base64url');
  await HandoffModel.create({ codeHash: sha256(code), userId: new Types.ObjectId(userId), origin, rememberMe: session?.rememberMe ?? false, expiresAt: new Date(now.getTime() + TTL_MS) });
  return { code, expiresInSeconds: TTL_MS / 1000 };
}

/** On the domain: the code once, there only, within the minute → a new session of that person on this domain. */
export async function redeemHandoff(code: string, origin: string | undefined, ctx: Omit<SessionContext, 'rememberMe'>, now = new Date()): Promise<IssuedTokens> {
  const expired = () => AppError.unauthenticated('This link has expired — please sign in');
  const h = await HandoffModel.findOneAndUpdate({ codeHash: sha256(code), usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }, { returnDocument: 'after' }).lean();
  if (!h || h.origin !== origin) throw expired();
  const user = await UserModel.findById(h.userId).select('status').lean();
  if (!user || user.status === 'disabled') throw expired();
  return issueNewSession(h.userId, { ...ctx, rememberMe: h.rememberMe });
}
