/**
 * Express 4 does not catch rejected promises from async route handlers — the
 * request just hangs. Wrap every async controller in this:
 *
 *   router.post('/sales', asyncHandler(posController.createSale));
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export const asyncHandler =
  (fn: AsyncFn): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
