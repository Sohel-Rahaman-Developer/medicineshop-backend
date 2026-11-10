import { rhu } from '../../utils/money';
import type { DayBasis, Mark, PayKind } from './payroll.model';

/** The EPF wage ceiling: 12% is worked out on pay up to ₹15,000 a month. */
export const PF_CEILING = 1_500_000;
export const PF_RATE = 12;

export interface CalcPerson {
  payKind: PayKind;
  pay: number;
  weeklyOff: number[];
  paidLeaves: number;
  extraRate?: number | null;
  pf: boolean;
  /** "YYYY-MM-DD" */
  joinedOn: string;
  leftOn?: string | null;
}

export interface CalcDay {
  day: string;
  weekday: number;
  employed: boolean;
  off: boolean;
  /** Present / Off are null. */
  mark: Mark | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const daysIn = (month: string) => {
  const [y = 0, m = 0] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
export const lastDayOf = (month: string) => `${month}-${pad(daysIn(month))}`;

/** Every calendar day of the month with its mark, weekly off and whether the person worked here then. */
export function monthDays(month: string, p: Pick<CalcPerson, 'weeklyOff' | 'joinedOn' | 'leftOn'>, marks: ReadonlyMap<string, Mark>): CalcDay[] {
  const [y = 0, m = 0] = month.split('-').map(Number);
  return Array.from({ length: daysIn(month) }, (_, i) => {
    const day = `${month}-${pad(i + 1)}`;
    const weekday = new Date(Date.UTC(y, m - 1, i + 1)).getUTCDay();
    const employed = day >= p.joinedOn && (!p.leftOn || day <= p.leftOn);
    return { day, weekday, employed, off: p.weeklyOff.includes(weekday), mark: employed ? (marks.get(day) ?? null) : null };
  });
}

/** A month's pay, every step kept so the screen can show its working (D114). Money in paise. */
export function salaryFor(month: string, p: CalcPerson, marks: ReadonlyMap<string, Mark>, o: { dayBasis: DayBasis; bonusWithSalary?: number; advanceDue?: number; advanceCut?: number | null }) {
  const days = monthDays(month, p, marks);
  const total = days.length;
  const at = days.filter((d) => d.employed);
  const work = at.filter((d) => !d.off);
  const count = (k: Mark) => at.filter((d) => d.mark === k).length;
  const absent = count('absent');
  const half = count('half');
  const leave = count('leave');
  const extra = count('extra');
  const divisor = o.dayBasis === 'thirty' ? 30 : total;
  const dayRate = p.payKind === 'day' ? p.pay : rhu(p.pay, divisor);
  // A month's pay covers its weekly offs; a day wage pays the days worked.
  const fullMonth = at.length === total;
  const base = p.payKind === 'day' ? dayRate * work.length : fullMonth ? p.pay : Math.min(p.pay, dayRate * at.length);
  const missed = absent + half / 2;
  const covered = Math.min(p.paidLeaves, missed);
  const unpaid = missed - covered;
  const cut = Math.min(base, rhu(dayRate * unpaid * 2, 2));
  const extraRate = p.extraRate ?? dayRate;
  const extraPay = extraRate * extra;
  const earned = base - cut + extraPay;
  const bonus = o.bonusWithSalary ?? 0;
  const gross = earned + bonus;
  // PF on the pay for the month's own days: not on extra days or bonus.
  const pfWage = p.pf ? Math.min(base - cut, PF_CEILING) : 0;
  const pfEmployee = rhu(pfWage * PF_RATE, 100);
  const pfShop = pfEmployee;
  const advanceDue = o.advanceDue ?? 0;
  const maxCut = Math.max(0, Math.min(advanceDue, gross - pfEmployee));
  const advanceCut = o.advanceCut == null ? maxCut : o.advanceCut;
  return {
    month,
    days,
    daysInMonth: total,
    employedDays: at.length,
    workDays: work.length,
    fullMonth,
    counts: { present: work.filter((d) => d.mark === null).length, absent, half, leave, extra, off: at.filter((d) => d.off && d.mark === null).length },
    divisor,
    dayRate,
    base,
    missed,
    covered,
    unpaid,
    cut,
    extraRate,
    extraPay,
    earned,
    bonus,
    gross,
    pfWage,
    pfEmployee,
    pfShop,
    advanceDue,
    maxCut,
    advanceCut,
    net: gross - pfEmployee - advanceCut,
  };
}
export type Salary = ReturnType<typeof salaryFor>;
