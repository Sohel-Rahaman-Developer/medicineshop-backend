import { Types } from 'mongoose';
import { rupees } from '../../core/export';
import { AppError } from '../../core/errors';
import { invoicePdf, type InvoiceSpec } from '../../core/invoice-pdf';
import type { TenantContext } from '../../core/middleware/tenant';
import { dayLabel } from '../../utils/date';
import { rupeesInWords } from '../../utils/words';
import { ShopModel } from '../shops/shop.model';
import { logoBytes } from '../shops/shop-logo';
import type { Salary } from './payroll.calc';
import { EmployeeModel, PayEntryModel, type Employee, type PayEntry } from './payroll.model';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5)) - 1] ?? ''} ${m.slice(0, 4)}`;
const MODE: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK: 'Bank transfer' };
const days = (n: number) => `${String(n)} ${n === 1 ? 'day' : 'days'}`;

/** A paid salary, its person and the month as it was worked out when paid. */
export async function paidSalary(t: TenantContext, id: string) {
  const x = await PayEntryModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), kind: 'salary', status: 'active' }).lean<PayEntry>();
  if (!x?.employeeId || !x.month) throw AppError.notFound('Payslip not found — the salary may be undone');
  const e = await EmployeeModel.findOne({ shopId: t.shopId, _id: x.employeeId }).lean<Employee>();
  if (!e) throw AppError.notFound('Person not found');
  return { x, e, c: x.calc as Omit<Salary, 'days'>, month: x.month };
}

/** The lines of the slip, each with its own working (D114 "show the working"). */
export function slipLines(e: Pick<Employee, 'payKind' | 'pay'>, c: Omit<Salary, 'days'>, month: string): [string, string, number][] {
  const out: [string, string, number][] = [];
  if (e.payKind === 'day') out.push(['Wages', `${days(c.workDays)} × ${rupees(c.dayRate)}`, c.base]);
  else if (c.fullMonth) out.push([`Salary for ${monthName(month)}`, `${rupees(e.pay)} a month`, c.base]);
  else out.push([`Salary, ${String(c.employedDays)} of ${String(c.daysInMonth)} days`, `${days(c.employedDays)} × ${rupees(c.dayRate)}`, c.base]);
  if (c.cut > 0) out.push(['Days not paid', `${String(c.missed)} missed − ${String(c.covered)} paid leave = ${days(c.unpaid)} × ${rupees(c.dayRate)}`, -c.cut]);
  if (c.extraPay > 0) out.push(['Extra days', `${days(c.counts.extra)} × ${rupees(c.extraRate)}`, c.extraPay]);
  if (c.bonus > 0) out.push(['Bonus', 'With this salary', c.bonus]);
  if (c.pfEmployee > 0) out.push(['PF (12%)', `12% of ${rupees(c.pfWage)}`, -c.pfEmployee]);
  if (c.advanceCut > 0) out.push(['Advance recovered', 'From advances given earlier', -c.advanceCut]);
  if (c.roundOff) out.push(['Round off', 'To the whole rupee', c.roundOff]);
  return out;
}

export interface SlipInput {
  shop: { name: string; line: string; logo: Buffer | null };
  e: Pick<Employee, 'name' | 'job' | 'phone' | 'pf' | 'uan' | 'payKind' | 'pay'>;
  x: Pick<PayEntry, 'date' | 'paymentMode' | 'amount' | 'createdByName'>;
  c: Omit<Salary, 'days'>;
  month: string;
}

/** The payslip on the shared invoice layout (A5, like the bill). */
export function slipSpec({ shop, e, x, c, month }: SlipInput): InvoiceSpec {
  const n = c.counts;
  return {
    size: 'A5',
    title: 'Payslip',
    meta: [['Month', monthName(month)], ['Paid on', dayLabel(x.date)], ['Paid by', MODE[x.paymentMode ?? ''] ?? '—']],
    logoImage: shop.logo,
    issuer: { name: shop.name, lines: [shop.line] },
    parties: [
      { label: 'Paid to', lines: [e.name, [e.job, e.phone].filter(Boolean).join(' · '), e.pf && e.uan ? `UAN ${e.uan}` : ''].filter(Boolean) },
      { label: 'Attendance', lines: [`${String(n.present)} present · ${String(n.absent)} absent · ${String(n.half)} half day`, `${String(n.leave)} paid leave · ${String(n.extra)} extra · ${String(n.off)} off`, `Worked here ${String(c.employedDays)} of ${String(c.daysInMonth)} days`] },
    ],
    columns: [{ label: 'Item', w: 2.2 }, { label: 'How', w: 3.4 }, { label: 'Amount', w: 1.3, num: true }],
    rows: slipLines(e, c, month).map(([item, how, amt]) => ({ cells: [item, how, rupees(amt)] })),
    totals: [
      { label: 'Earned', value: rupees(c.earned) },
      ...(c.bonus ? [{ label: 'Bonus', value: rupees(c.bonus) }] : []),
      ...(c.pfEmployee + c.advanceCut ? [{ label: 'Deductions', value: rupees(-(c.pfEmployee + c.advanceCut)) }] : []),
      ...(c.roundOff ? [{ label: 'Round off', value: rupees(c.roundOff) }] : []),
      { label: 'Net pay', value: rupees(x.amount), strong: true },
    ],
    words: rupeesInWords(x.amount),
    notes: [e.payKind === 'month' ? `A day’s pay: ${rupees(e.pay)} ÷ ${String(c.divisor)} = ${rupees(c.dayRate)}.` : `Daily wage ${rupees(c.dayRate)}.`, ...(c.pfShop ? [`The shop adds its own PF share of ${rupees(c.pfShop)} with EPFO.`] : []), `Paid by ${x.createdByName}.`],
    footer: 'Computer-generated payslip · Powered by MedBox24',
  };
}

export async function payslipPdf(t: TenantContext, id: string) {
  const { x, e, c, month } = await paidSalary(t, id);
  const [shop, logo] = await Promise.all([ShopModel.findById(t.shopId).select('name address phone').lean(), logoBytes(t.shopId)]);
  const a = shop?.address;
  const line = [a?.line1, a?.line2, a ? `${a.city} ${a.pincode}` : '', shop?.phone].filter(Boolean).join(', ');
  const pdf = await invoicePdf(slipSpec({ shop: { name: shop?.name ?? 'MedBox24', line, logo }, e, x, c, month }));
  return { pdf, name: `Payslip ${e.name} ${monthName(month)}`, x, e, c, month, shopName: shop?.name ?? 'MedBox24' };
}
