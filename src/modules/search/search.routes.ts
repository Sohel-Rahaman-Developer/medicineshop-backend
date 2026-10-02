import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched } from '../../core/response';
import { search } from './search.service';

export const searchRouter = Router();
searchRouter.use(requireAuth, tenant);

const querySchema = z.object({ q: z.string().trim().min(2, 'Type at least 2 letters').max(60) }).strict();

searchRouter.get(
  '/',
  validate({ query: querySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await search(tenantOf(req), (req.query as unknown as { q: string }).q));
  }),
);
