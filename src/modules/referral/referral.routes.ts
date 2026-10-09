import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched } from '../../core/response';
import { checkCode, forShop } from './referral.service';

// D80: the owner's Refer a shop card; onboarding checks a code before the shop exists (signed in, no shop yet).
export const referralRouter = Router();

referralRouter.get('/check', requireAuth, validate({ query: z.object({ code: z.string().trim().min(1, 'Type the code').max(20) }).strict() }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await checkCode(req.auth?.userId ?? '', (req.query as { code: string }).code)); }));
referralRouter.get('/', shopAuth, requirePermission('subscription', 'view'), asyncHandler(async (req: Request, res: Response) => { fetched(res, await forShop(tenantOf(req).shopId)); }));
