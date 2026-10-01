import type { Response } from 'express';

export interface Meta {
  /** Cursor pagination — see PLAN.md §33.2 */
  nextCursor?: string | null;
  hasMore?: boolean;
  limit?: number;
  total?: number;
}

export function sent(res: Response, data: unknown, message: string, status = 200): void {
  res.status(status).json({ success: true, data, message });
}

export function fetched(res: Response, data: unknown, meta?: Meta): void {
  res.json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function created(res: Response, data: unknown, message: string): void {
  sent(res, data, message, 201);
}
