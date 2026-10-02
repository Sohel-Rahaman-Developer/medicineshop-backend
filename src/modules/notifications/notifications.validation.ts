import { z } from 'zod';
import { NOTIFICATION_TYPES } from './notification.catalog';

const key = z.string().trim().min(1).max(120);

export const listSchema = z.object({ all: z.enum(['0', '1']).optional() }).strict();
export const readSchema = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ keys: z.array(key).min(1).max(100) }).strict()]);
export const snoozeSchema = z.object({ key }).strict();
export const prefsSchema = z
  .object({ off: z.array(z.object({ kind: z.enum(NOTIFICATION_TYPES as [string, ...string[]]), channel: z.enum(['inapp', 'email']) }).strict()).max(100) })
  .strict();

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 08:00');

/** Shop alert settings (settings:edit): the expiry alert days — any 1 to 5 — and when the mails go out. */
export const alertSettingsSchema = z
  .object({
    expiryAlertDays: z
      .array(z.number('Days must be a number').int('Whole days').min(1, 'At least 1 day').max(365, 'At most 365 days'))
      .min(1, 'Pick at least one')
      .max(5, 'At most 5')
      .refine((v) => new Set(v).size === v.length, 'The same day twice'),
    alertDigestTime: clock,
    dailySummaryTime: clock,
    emailEnabled: z.boolean(),
  })
  .strict();
export type AlertSettingsInput = z.infer<typeof alertSettingsSchema>;

export type PrefsInput = { off: { kind: (typeof NOTIFICATION_TYPES)[number]; channel: 'inapp' | 'email' }[] };
