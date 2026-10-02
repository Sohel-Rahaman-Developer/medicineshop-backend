import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as svc from './loyalty.service';
import { adjustSchema, loyaltyListSchema, loyaltySummarySchema, rulesSchema, type AdjustInput, type LoyaltyListQuery, type LoyaltySummaryQuery, type RulesInput } from './loyalty.validation';

const DAY = 24 * 60 * 60 * 1000;

// PLAN §22: settings and manual points need loyalty:edit (D23); the counter's redeem is checked on the bill.
export const loyaltyRouter = Router();
loyaltyRouter.use(requireAuth, tenant);
const view = requirePermission('loyalty', 'view');
const edit = requirePermission('loyalty', 'edit');

loyaltyRouter.get('/settings', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.getRules(tenantOf(req))); }));

loyaltyRouter.patch(
  '/settings',
  edit,
  validate({ body: rulesSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.updateRules(tenantOf(req), await actorOf(req), req.body as RulesInput, req.ip), 'Loyalty settings saved');
  }),
);

loyaltyRouter.get(
  '/summary',
  view,
  validate({ query: loyaltySummarySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as LoyaltySummaryQuery;
    const to = q.to ?? new Date();
    fetched(res, await svc.summary(tenantOf(req), q.from ?? new Date(to.getTime() - 29 * DAY), to));
  }),
);

loyaltyRouter.get(
  '/transactions',
  view,
  validate({ query: loyaltyListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.transactions(tenantOf(req), req.query as unknown as LoyaltyListQuery);
    fetched(res, items, meta);
  }),
);

loyaltyRouter.get('/customers/:id', view, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.card(tenantOf(req), (req.params as { id: string }).id)); }));

loyaltyRouter.post(
  '/adjust',
  edit,
  validate({ body: adjustSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await svc.adjust(tenantOf(req), await actorOf(req), req.body as AdjustInput, req.ip);
    const msg = `${result.points > 0 ? '+' : ''}${String(result.points)} points · balance ${String(result.balance)}`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);
