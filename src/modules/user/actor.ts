import type { Request } from 'express';
import { AppError } from '../../core/errors';
import { UserModel } from './user.model';

export interface Actor {
  id: string;
  name: string;
  email: string;
}

/** The signed-in user as audit entries and emails name them. */
export async function actorOf(req: Request): Promise<Actor> {
  if (!req.auth) throw AppError.unauthenticated();
  const user = await UserModel.findById(req.auth.userId).select('name email status').lean();
  if (!user || user.status !== 'active') throw AppError.unauthenticated();
  return { id: String(user._id), name: user.name || user.email, email: user.email };
}
