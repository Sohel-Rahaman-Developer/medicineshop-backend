/**
 * Express 4 async route handlers ke rejected promises apne aap nahi pakadta —
 * request latak jaati hai. Har async controller ko isme wrap karo:
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
