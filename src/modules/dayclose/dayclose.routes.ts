import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched } from '../../core/response';
import { actorOf } from '../user/actor';
import * as svc from './dayclose.service';

// PLAN §35.3: the counter closes its own drawer (pos:create); who else sees it is Q24.
export const dayCloseRouter = Router();
dayCloseRouter.use(shopAuth);
const counter = requirePermission('pos', 'create');

dayCloseRouter.get(
  '/',
  counter,
  validate({ query: svc.statusSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.status(tenantOf(req), (req.query as { day?: Date }).day));
  }),
);

dayCloseRouter.get(
  '/history',
  counter,
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.history(tenantOf(req)));
  }),
);

dayCloseRouter.post(
  '/',
  counter,
  validate({ body: svc.closeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const c = await svc.close(tenantOf(req), await actorOf(req), req.body as svc.CloseInput, req.ip);
    created(res, c, `${c.day} closed`);
  }),
);
