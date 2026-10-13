import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { perUser } from '../../core/middleware/rate-limit';
import { validate } from '../../core/middleware/validate';
import { sent } from '../../core/response';
import { recordBrowser, type PerfSampleInput } from './perf';

/** A signed-in browser reports loads that kept the person waiting; only paths and times, never what was on screen. */
export const perfRouter = Router();

const ms = z.number().min(0).max(600_000);
const path = z.string().trim().min(1).max(160).regex(/^[\w\-/:.[\] ]+$/);
const item = z.object({ kind: z.enum(['api', 'page', 'load', 'asset']), path, screen: z.union([path, z.literal('')]), ms, server: ms.nullable(), db: ms.nullable() }).strict();

perfRouter.post('/', requireAuth, perUser({ limit: 10 }), validate({ body: z.object({ items: z.array(item).min(1).max(20) }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  await recordBrowser((req.body as { items: PerfSampleInput[] }).items);
  sent(res, null, 'Thanks');
}));
