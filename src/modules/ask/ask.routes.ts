import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { asyncHandler } from '../../core/async-handler';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { perUser } from '../../core/middleware/rate-limit';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { actorOf } from '../user/actor';
import { ask, askSchema, offer, switchAi, type AskInput } from './ask.service';

// D81: everyone in the shop can ask; each answer follows the asker's own permissions.
export const askRouter = Router();
askRouter.use(shopAuth);
const member = requirePermission('dashboard', 'view');

askRouter.get('/offer', member, asyncHandler(async (req: Request, res: Response) => { fetched(res, await offer(tenantOf(req))); }));
askRouter.post('/', member, perUser({ limit: env.RATE_ASK_PER_USER_PER_MIN }), validate({ body: askSchema }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await ask(tenantOf(req), await actorOf(req), req.body as AskInput)); }));
askRouter.put(
  '/ai',
  requirePermission('subscription', 'edit'),
  validate({ body: z.object({ on: z.boolean() }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const on = (req.body as { on: boolean }).on;
    sent(res, await switchAi(tenantOf(req), await actorOf(req), on, req.ip), on ? 'AI answers are on' : 'AI answers are off');
  }),
);
