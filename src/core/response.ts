/**
 * Standard response envelope.
 *
 * ══ RULE ════════════════════════════════════════════════════════════
 *
 * Every message a user sees comes from the backend. The frontend never
 * hardcodes API messages — it just renders `message` / `error.message`.
 *
 * Why this matters: an Android release ships on the user's schedule. A message
 * hardcoded in the app can only be fixed once every user updates from the Play
 * Store, which can take weeks. A message that comes from the API is fixed in
 * one deploy, across web, desktop and Android at once.
 *
 * Shape is always:
 *   success →  { success: true,  data, message?, meta? }
 *   failure →  { success: false, error: { code, message, details? } }
 *
 * `code` is for the machine (the frontend decides what to do with it),
 * `message` is for the human. Keeping them separate means copy can change any
 * time without breaking frontend logic — and if we ever add a second language,
 * `code` becomes the mapping key.
 */
import type { Response } from 'express';

export interface Meta {
  /** Cursor pagination — see PLAN.md §33.2 */
  nextCursor?: string | null;
  hasMore?: boolean;
  limit?: number;
  total?: number;
}

/**
 * Response for a mutation (POST/PATCH/DELETE).
 * `message` is REQUIRED here — the user needs to be told what happened.
 */
export function sent<T>(res: Response, data: T, message: string, status = 200): void {
  res.status(status).json({ success: true, data, message });
}

/**
 * Response for a read (GET).
 * `message` is optional — there is no point toasting every time a list loads.
 */
export function fetched<T>(res: Response, data: T, meta?: Meta): void {
  res.json({ success: true, data, ...(meta ? { meta } : {}) });
}

/** A new record was created — responds with 201. */
export function created<T>(res: Response, data: T, message: string): void {
  sent(res, data, message, 201);
}
