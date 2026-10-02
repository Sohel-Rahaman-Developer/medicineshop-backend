import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched } from '../../core/response';
import { istDay } from '../../core/zod';
import * as pnl from './pnl.service';

const rangeSchema = z
  .object({ from: istDay, to: istDay })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'From is after To', path: ['from'] })
  .refine((v) => v.to.getTime() - v.from.getTime() <= 400 * 24 * 60 * 60 * 1000, { message: 'At most about a year at a time', path: ['to'] });
const monthSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-10') }).strict();

// PLAN §20 / sandbox money.js: P&L and the day book need reports:view (the same gate as seeing cost).
export const reportsRouter = Router();
reportsRouter.use(requireAuth, tenant, requirePermission('reports', 'view'));

reportsRouter.get(
  '/pnl',
  validate({ query: rangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from: Date; to: Date };
    fetched(res, await pnl.pnl(tenantOf(req), q.from, q.to));
  }),
);

reportsRouter.get('/pnl/months', asyncHandler(async (req: Request, res: Response) => { fetched(res, await pnl.months(tenantOf(req))); }));

reportsRouter.get(
  '/daybook',
  validate({ query: monthSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await pnl.daybook(tenantOf(req), (req.query as { month: string }).month));
  }),
);
