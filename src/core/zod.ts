import { z } from 'zod';
import { monthEndIST } from '../utils/date';
import { part } from './lang';

// Boxes a schema gives no message of its own: plain words a shop can read (and translate), not zod's "Invalid input: expected string".
z.config({
  customError: (iss) => {
    if (iss.code === 'invalid_type' && iss.input === undefined) return part('This is required');
    if (iss.code === 'too_small' && iss.origin === 'string') return iss.minimum === 1 ? part('This is required') : part(`At least ${String(iss.minimum)} characters`);
    if (iss.code === 'too_big' && iss.origin === 'string') return part(`At most ${String(iss.maximum)} characters`);
    return undefined;
  },
});

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

// ₹1 crore: a cancer vial, a big bill or a year's rent fits; a typo of extra zeros does not.
export const paise = (label: string, max = 1_000_000_000) =>
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
