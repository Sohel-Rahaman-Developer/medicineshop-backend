import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { AppError } from '../../core/errors';
import { validate } from '../../core/middleware/validate';
import { fetched } from '../../core/response';
import { BRAND_FILES, brandFile, brandInfo, type BrandFile } from './branding.service';

/** Public: is a custom logo in use, and its files — the shop and admin apps serve the built-in logo when there is none. */
export const brandRouter = Router();

brandRouter.get('/', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await brandInfo()); }));

brandRouter.get(
  '/:file',
  validate({ params: z.object({ file: z.enum(BRAND_FILES) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const file = (req.params as { file: BrandFile }).file;
    const body = await brandFile(file);
    if (!body) throw AppError.notFound('No custom logo — the built-in one is in use');
    res.set({ 'Content-Type': file.endsWith('.ico') ? 'image/x-icon' : 'image/png', 'Cache-Control': 'public, max-age=300', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.send(body);
  }),
);
