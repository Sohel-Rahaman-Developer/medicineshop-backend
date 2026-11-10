// Local look at the payslip without a database: `npx tsx scripts/preview-payslip.ts <out dir>`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invoicePdf } from '../src/core/invoice-pdf';
import { salaryFor } from '../src/modules/payroll/payroll.calc';
import { slipSpec } from '../src/modules/payroll/payroll.pdf';

const out = process.argv[2] ?? '.';

async function main() {
  const meera = { name: 'Meera Sen', job: 'Pharmacist', phone: '98300 55556', pf: true, uan: '100200300400', payKind: 'month' as const, pay: 2_000_000, weeklyOff: [0], paidLeaves: 1, joinedOn: '2025-04-01' };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the slip uses the month without its day list
  const { days, ...c } = salaryFor('2026-10', meera, new Map([['2026-10-06', 'absent'], ['2026-10-07', 'absent'], ['2026-10-08', 'half'], ['2026-10-11', 'extra']]), { dayBasis: 'thirty', bonusWithSalary: 150_000, advanceDue: 300_000, advanceCut: 300_000 });
  const spec = slipSpec({ shop: { name: 'Shri Ram Medical Store', line: '14B Park Street, Kolkata 700016, 033 2229 4410', logo: null }, e: meera, x: { date: new Date('2026-10-31T06:30:00Z'), paymentMode: 'CASH', amount: c.net, createdByName: 'Rohit Agarwal' }, c, month: '2026-10' });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a folder the developer names
  writeFileSync(join(out, 'payslip.pdf'), await invoicePdf(spec));
}

void main();
