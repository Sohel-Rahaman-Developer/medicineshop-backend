import { z } from 'zod';
import { monthEndIST } from '../utils/date';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const idParams = z.object({ id: objectId }).strict();

/** "2027-08" → 2027-08-31 23:59:59 IST, the way a pack's "EXP 08/2027" is meant (PLAN §26). */
export const monthEnd = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use month and year, like 08/2027')
  .transform((v) => {
    const [y = 0, m = 0] = v.split('-').map(Number);
    return monthEndIST(y, m);
  });

/** Client-made UUID that makes a stock or money POST safe to retry (PLAN §26). */
export const clientRequestId = z.uuid('Missing request id');

export const paise = (label: string, max = 10_000_000) =>
  z.number(`${label} must be a number`).int(`${label} must be in whole paise`).min(0, `${label} can’t be negative`).max(max, `${label} is too large`);

export const LIMIT = z.coerce.number().int().min(1).max(100).default(30);

/** "2026-10-02" → 00:00 IST that day; invoice and payment dates are calendar days in India. */
export const istDay = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use a valid date')
  .transform((v, ctx) => {
    const [y = 0, m = 0, d = 0] = v.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d) - 5.5 * 60 * 60 * 1000);
    if (new Date(at.getTime() + 5.5 * 60 * 60 * 1000).getUTCDate() !== d) ctx.addIssue({ code: 'custom', message: 'Use a valid date' });
    return at;
  });
