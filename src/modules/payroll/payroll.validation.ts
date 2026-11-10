import { z } from 'zod';
import { clientRequestId, istDay, objectId, paise } from '../../core/zod';
import { EXPENSE_MODES } from '../expenses/expense.model';
import { DAY_BASES, MARKS, PAY_KINDS } from './payroll.model';

const text = (max: number) => z.string().trim().max(max, `At most ${String(max)} letters`).default('');
export const monthText = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11');
const isoDayText = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use a valid date');

const person = {
  name: z.string().trim().min(2, 'Enter the name').max(60, 'At most 60 letters'),
  phone: text(20),
  job: text(40),
  payKind: z.enum(PAY_KINDS, 'Choose monthly or daily pay'),
  pay: paise('Pay', 100_000_000).min(100, 'Enter the pay'),
  weeklyOff: z.array(z.number().int().min(0).max(6)).max(6, 'Keep at least one working day').default([]).transform((l) => [...new Set(l)].sort()),
  paidLeaves: z.number().int('Whole days').min(0).max(10, 'At most 10 days a month').default(0),
  extraRate: paise('Extra day pay', 10_000_000).nullable().default(null),
  pf: z.boolean().default(false),
  uan: z.string().trim().refine((v) => v === '' || /^\d{12}$/.test(v), 'A UAN has 12 digits').default(''),
  joinedOn: istDay,
  leftOn: istDay.nullable().default(null),
};
const leftAfterJoin = (v: { joinedOn: Date; leftOn: Date | null }) => !v.leftOn || v.leftOn >= v.joinedOn;
const leftMsg = { message: 'The last day can’t be before the first', path: ['leftOn'] };

export const employeeSchema = z.object(person).strict().refine(leftAfterJoin, leftMsg);
export type EmployeeInput = z.infer<typeof employeeSchema>;

export const settingsSchema = z.object({ dayBasis: z.enum(DAY_BASES) }).strict();

export const monthQuery = z.object({ month: monthText }).strict();
export const dayQuery = z.object({ day: isoDayText }).strict();

export const markSchema = z.object({ employeeId: objectId, day: isoDayText, mark: z.enum([...MARKS, 'present'], 'Choose a mark') }).strict();
export type MarkInput = z.infer<typeof markSchema>;

const paid = {
  paymentMode: z.enum(EXPENSE_MODES, 'Choose how it was paid'),
  fromDrawer: z.boolean().default(false),
  date: istDay,
};

export const advanceSchema = z.object({ clientRequestId, employeeId: objectId, amount: paise('Amount', 100_000_000).min(100, 'Enter an amount'), note: text(120), ...paid }).strict();
export type AdvanceInput = z.infer<typeof advanceSchema>;

export const bonusSchema = z
  .object({
    clientRequestId,
    employeeId: objectId,
    month: monthText,
    amount: paise('Amount', 100_000_000).min(100, 'Enter an amount'),
    note: text(120),
    paidNow: z.boolean(),
    paymentMode: z.enum(EXPENSE_MODES).optional(),
    fromDrawer: z.boolean().default(false),
    date: istDay.optional(),
  })
  .strict()
  .refine((v) => !v.paidNow || (v.paymentMode && v.date), { message: 'Say how and when it was paid', path: ['paymentMode'] });
export type BonusInput = z.infer<typeof bonusSchema>;

export const paySchema = z
  .object({
    clientRequestId,
    employeeId: objectId,
    month: monthText,
    advanceCut: paise('Advance cut', 100_000_000),
    /** The amount on the screen: a change since then (a mark, an advance) refuses the payment. */
    expect: paise('Amount', 100_000_000),
    note: text(120),
    ...paid,
  })
  .strict();
export type PayInput = z.infer<typeof paySchema>;

export const pfSchema = z.object({ clientRequestId, month: monthText, amount: paise('Amount', 100_000_000).min(1, 'Nothing to deposit'), reference: text(40), date: istDay }).strict();
export type PfInput = z.infer<typeof pfSchema>;

export const removeSchema = z.object({ reason: z.string().trim().min(3, 'Say why (3 letters at least)').max(200) }).strict();
