import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { AppError } from '../../core/errors';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched } from '../../core/response';
import { istDay } from '../../core/zod';
import * as svc from './dashboard.service';

const rangeSchema = z
  .object({ from: istDay, to: istDay })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'From is after To', path: ['from'] })
  .refine((v) => v.to.getTime() - v.from.getTime() <= 400 * 24 * 60 * 60 * 1000, { message: 'At most about a year at a time', path: ['to'] });

const userOf = (req: Request) => {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth.userId;
};

// SANDBOX §5.3: one Home per role; every block is cut to the person's permissions on the server.
export const dashboardRouter = Router();
dashboardRouter.use(shopAuth, requirePermission('dashboard', 'view'));

dashboardRouter.get(
  '/',
  validate({ query: rangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from: Date; to: Date };
    fetched(res, await svc.overview(tenantOf(req), userOf(req), q.from, q.to));
  }),
);

dashboardRouter.get(
  '/charts',
  validate({ query: rangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from: Date; to: Date };
    fetched(res, await svc.charts(tenantOf(req), userOf(req), q.from, q.to));
  }),
);
