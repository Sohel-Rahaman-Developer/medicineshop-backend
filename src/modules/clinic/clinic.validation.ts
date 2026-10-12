import { z } from 'zod';
import { clientRequestId, objectId, paise } from '../../core/zod';
import { phone } from '../shops/shops.validation';
import { FEE_MODES, PAYOUT_MODES } from './clinic.model';

const text = (label: string, max: number) => z.string().trim().max(max, `${label} is at most ${String(max)} characters`);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 19:00');
export const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use a valid date');

const sitting = z
  .object({ day: z.number().int().min(0).max(6), start: clock, end: clock, max: z.number('Patients must be a number').int().min(1, 'At least 1 patient').max(200, 'At most 200 patients') })
  .strict()
  .refine((s) => s.end > s.start, { message: 'Ends before it starts', path: ['end'] });

export const chamberSchema = z
  .object({
    fee: paise('Fee', 2_000_000),
    freeDays: z.number('Days must be a number').int().min(0).max(90, 'At most 90 days'),
    commission: z.object({ mode: z.enum(['pct', 'flat']), value: z.number('Commission must be a number').int().min(0) }).strict(),
    minutes: z.number('Minutes must be a number').int().min(2, 'At least 2 minutes').max(60, 'At most 60 minutes'),
    sittings: z.array(sitting).max(21, 'At most 21 sittings a week'),
  })
  .strict()
  .refine((c) => c.commission.mode !== 'pct' || c.commission.value <= 100, { message: 'At most 100%', path: ['commission', 'value'] })
  .refine((c) => c.commission.mode !== 'flat' || c.commission.value <= c.fee, { message: 'More than the fee', path: ['commission', 'value'] })
  .superRefine((c, ctx) => {
    c.sittings.forEach((s, i) => {
      if (c.sittings.some((o, j) => j !== i && o.day === s.day && o.start < s.end && s.start < o.end)) ctx.addIssue({ code: 'custom', message: 'Two sittings overlap on this day', path: ['sittings', i, 'start'] });
    });
  });

export const bookSchema = z
  .object({
    clientRequestId,
    doctorId: objectId,
    day,
    start: clock,
    phone: phone('Phone'),
    /** A customer picked from the phone search; else the phone finds or makes one. */
    customerId: objectId.optional(),
    /** Who books, when the phone is new — often the patient's family. */
    bookerName: text('Name', 80).default(''),
    patient: z.object({ name: text('Patient', 80).min(2, 'Type the patient’s name'), age: z.number().int().min(0).max(120).nullable().default(null), gender: z.enum(['', 'female', 'male', 'other']).default('') }).strict(),
    kind: z.enum(['new', 'followup']),
    fee: paise('Fee', 2_000_000),
    /** Paid now (advance); otherwise at the visit. */
    payMode: z.enum(FEE_MODES).optional(),
    note: text('Note', 200).default(''),
  })
  .strict();

export const payFeeSchema = z.object({ mode: z.enum(FEE_MODES, 'Choose cash, UPI or card') }).strict();
export const visitStatusSchema = z.object({ status: z.enum(['booked', 'arrived', 'seen', 'no_show']) }).strict();
export const cancelVisitSchema = z.object({ reason: text('Reason', 200).min(3, 'A reason is required'), refundMode: z.enum(FEE_MODES).optional() }).strict();
export const moveVisitSchema = z.object({ day, start: clock }).strict();
export const visitFeeSchema = z.object({ kind: z.enum(['new', 'followup']), fee: paise('Fee', 2_000_000) }).strict();
export const sittingOffSchema = z.object({ doctorId: objectId, day, start: clock, reason: text('Reason', 200).default('') }).strict();
export const payoutSchema = z
  .object({ clientRequestId, doctorId: objectId, amount: paise('Amount').min(100, 'At least ₹1'), mode: z.enum(PAYOUT_MODES, 'Choose cash, UPI or bank'), fromDrawer: z.boolean().default(false), note: text('Note', 200).default('') })
  .strict()
  .refine((p) => p.mode === 'CASH' || !p.fromDrawer, { message: 'Only cash comes from the drawer', path: ['fromDrawer'] });

export const dayQuery = z.object({ day: day.optional() }).strict();
export const slotsQuery = z.object({ doctorId: objectId, from: day.optional(), days: z.coerce.number().int().min(1).max(31).default(14) }).strict();
export const lookupQuery = z.object({ phone: phone('Phone'), doctorId: objectId.optional(), day: day.optional() }).strict();

export type ChamberInput = z.infer<typeof chamberSchema>;
export type BookInput = z.infer<typeof bookSchema>;
export type CancelVisitInput = z.infer<typeof cancelVisitSchema>;
export type PayoutInput = z.infer<typeof payoutSchema>;
export type SittingOffInput = z.infer<typeof sittingOffSchema>;
