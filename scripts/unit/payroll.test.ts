import assert from 'node:assert/strict';
import { test } from 'node:test';
import { salaryFor, type CalcPerson } from '../../src/modules/payroll/payroll.calc';
import type { Mark } from '../../src/modules/payroll/payroll.model';

// Nov 2026: 30 days, Sundays 1, 8, 15, 22, 29.
const ramesh: CalcPerson = { payKind: 'month', pay: 1_200_000, weeklyOff: [0], paidLeaves: 1, pf: false, joinedOn: '2025-04-01' };
const marks = (m: Record<string, Mark>) => new Map(Object.entries(m));

void test('D114: ₹12,000 a month — 2 absent and a half day, 1 paid leave covers one, an extra Sunday, a bonus and an advance', () => {
  const s = salaryFor('2026-11', ramesh, marks({ '2026-11-03': 'absent', '2026-11-04': 'absent', '2026-11-05': 'half', '2026-11-08': 'extra' }), { dayBasis: 'thirty', bonusWithSalary: 100_000, advanceDue: 200_000 });
  assert.equal(s.dayRate, 40_000, '₹12,000 ÷ 30 = ₹400');
  assert.equal(s.base, 1_200_000);
  assert.equal(s.missed, 2.5);
  assert.equal(s.covered, 1);
  assert.equal(s.cut, 60_000, '1.5 days × ₹400');
  assert.equal(s.extraPay, 40_000);
  assert.equal(s.earned, 1_180_000);
  assert.equal(s.gross, 1_280_000);
  assert.equal(s.advanceCut, 200_000, 'the whole advance comes off by default');
  assert.equal(s.net, 1_080_000);
  assert.deepEqual(s.counts, { present: 22, absent: 2, half: 1, leave: 0, extra: 1, off: 4 });
});

void test('D114: a day wage pays the working days; weekly offs are unpaid', () => {
  const s = salaryFor('2026-11', { ...ramesh, payKind: 'day', pay: 50_000, paidLeaves: 0 }, marks({ '2026-11-02': 'absent', '2026-11-09': 'leave' }), { dayBasis: 'thirty' });
  assert.equal(s.workDays, 25);
  assert.equal(s.base, 1_250_000, '25 days × ₹500');
  assert.equal(s.earned, 1_200_000, 'one absent day off; paid leave stays paid');
});

void test('D114: joined on the 16th — half a month at the day rate; never more than the month', () => {
  const s = salaryFor('2026-11', { ...ramesh, joinedOn: '2026-11-16' }, new Map(), { dayBasis: 'thirty' });
  assert.equal(s.employedDays, 15);
  assert.equal(s.base, 600_000, '15 × ₹400');
  const left = salaryFor('2026-11', { ...ramesh, leftOn: '2026-11-30' }, new Map(), { dayBasis: 'thirty' });
  assert.equal(left.base, 1_200_000, 'worked the whole month');
  const marked = salaryFor('2026-11', { ...ramesh, joinedOn: '2026-11-16' }, marks({ '2026-11-03': 'absent' }), { dayBasis: 'thirty' });
  assert.equal(marked.cut, 0, 'a mark before joining is not counted');
});

void test('D114: ÷ the days of the month — Feb 2027 has 28', () => {
  const s = salaryFor('2027-02', { ...ramesh, pay: 1_400_000, paidLeaves: 0 }, marks({ '2027-02-02': 'absent' }), { dayBasis: 'month' });
  assert.equal(s.divisor, 28);
  assert.equal(s.dayRate, 50_000);
  assert.equal(s.earned, 1_350_000);
});

void test('D114: PF 12% each on pay up to ₹15,000, not on extra days or bonus', () => {
  const big = salaryFor('2026-11', { ...ramesh, pay: 2_000_000, pf: true }, marks({ '2026-11-08': 'extra' }), { dayBasis: 'thirty', bonusWithSalary: 50_000 });
  assert.equal(big.pfWage, 1_500_000);
  assert.equal(big.pfEmployee, 180_000);
  assert.equal(big.pfShop, 180_000);
  assert.equal(big.net, big.gross - 180_000 + big.roundOff, 'whole rupees');
  const small = salaryFor('2026-11', { ...ramesh, pf: true, paidLeaves: 0 }, marks({ '2026-11-03': 'absent' }), { dayBasis: 'thirty' });
  assert.equal(small.pfWage, 1_160_000);
  assert.equal(small.pfEmployee, 139_200);
});

void test('D114: cuts stop at zero; the advance cut never takes more than the pay', () => {
  const away = salaryFor('2026-11', { ...ramesh, paidLeaves: 0 }, marks(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, 'absent']))), { dayBasis: 'thirty', advanceDue: 500_000 });
  assert.equal(away.earned, 0);
  assert.equal(away.maxCut, 0);
  assert.equal(away.net, 0);
  const part = salaryFor('2026-11', ramesh, new Map(), { dayBasis: 'thirty', advanceDue: 300_000, advanceCut: 100_000 });
  assert.equal(part.net, 1_100_000, 'the owner chose to cut ₹1,000 this month');
  assert.equal(part.maxCut, 300_000);
});

void test('D114: an extra day at its own rate', () => {
  const s = salaryFor('2026-11', { ...ramesh, extraRate: 60_000 }, marks({ '2026-11-15': 'extra', '2026-11-22': 'extra' }), { dayBasis: 'thirty' });
  assert.equal(s.extraPay, 120_000);
  assert.equal(s.counts.off, 3);
});

void test('D114: paid in whole rupees — ₹20,000 ÷ 30 leaves paise, the round-off shows them', () => {
  const s = salaryFor('2026-11', { ...ramesh, pay: 2_000_000 }, marks({ '2026-11-03': 'absent', '2026-11-04': 'absent', '2026-11-05': 'half' }), { dayBasis: 'thirty' });
  assert.equal(s.dayRate, 66_667, '₹666.67');
  assert.equal(s.cut, 100_001, '1.5 × ₹666.67 = ₹1,000.005 → ₹1,000.01');
  assert.equal(s.earned, 1_899_999);
  assert.equal(s.net, 1_900_000);
  assert.equal(s.roundOff, 1);
});
