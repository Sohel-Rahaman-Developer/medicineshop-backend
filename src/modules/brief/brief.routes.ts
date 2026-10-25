import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { needFeature, requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { fetched } from '../../core/response';
import { actorOf } from '../user/actor';
import { brief } from './brief.service';

// D103: the morning brief is for those who see the shop's money (owner, manager, accountant).
export const briefRouter = Router();
briefRouter.use(shopAuth, needFeature('brief'));

briefRouter.get('/', requirePermission('reports', 'view'), asyncHandler(async (req: Request, res: Response) => { fetched(res, await brief(tenantOf(req), (await actorOf(req)).id)); }));
