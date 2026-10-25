import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler } from '../../core/async-handler';
import { originShop, otherShopAddress } from '../../core/origins';
import { requireAuth } from '../../core/middleware/require-auth';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { mobile } from '../shops/shops.validation';
import { actorOf } from '../user/actor';
import { MembershipModel } from './membership.model';
import * as svc from './memberships.service';

export const invitationsRouter = Router();

const idSchema = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id') }).strict();
const acceptSchema = z
  .object({ name: z.string().trim().min(1, 'Your name is required').max(80), phone: mobile('Your phone').optional() })
  .strict();

invitationsRouter.use(requireAuth);

invitationsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.myInvitations(req.auth?.userId ?? ''));
  }),
);

invitationsRouter.post(
  '/:id/accept',
  validate({ params: idSchema, body: acceptSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const bound = await originShop(req.get('origin'));
    if (bound && !(await MembershipModel.exists({ _id: id, shopId: new Types.ObjectId(bound) }))) throw otherShopAddress();
    const shop = await svc.accept(req.auth?.userId ?? '', id, req.body as z.infer<typeof acceptSchema>, req.ip);
    sent(res, shop, `Welcome to ${shop.shopName}`);
  }),
);

invitationsRouter.post(
  '/:id/decline',
  validate({ params: idSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const actor = await actorOf(req);
    await svc.decline(actor.id, id, actor.name, req.ip);
    sent(res, null, 'Invitation declined');
  }),
);
