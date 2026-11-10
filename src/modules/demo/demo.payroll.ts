import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { contextFor } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import * as pay from '../payroll/payroll.service';
import { UserModel } from '../user/user.model';
import { DEMO_STAFF } from './demo.model';

const IST = 5.5 * 3_600_000;
const DAY = 86_400_000;
const at = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);

/** D114: the demo shop's payroll — its three staff (linked to their logins) and a delivery boy on a day wage,
 * attendance with a few absent, half and extra days, last month paid, an advance this month and PF due. */
export async function seedPayroll(shopId: Types.ObjectId, ownerId: Types.ObjectId, now: Date) {
  const { ctx } = await contextFor(shopId, ownerId);
  const owner = await UserModel.findById(ownerId).select('name email').lean();
  const actor = { id: String(ownerId), name: owner?.name ?? 'Owner', email: owner?.email ?? '' };
  const today = istIsoDay(now);
  const thisMonth = today.slice(0, 7);
  const last = new Date(Date.parse(`${thisMonth}-01T00:00:00Z`) - DAY).toISOString().slice(0, 7);
  const joined = at(`${String(Number(today.slice(0, 4)) - 1)}-04-01`);
  const users = await UserModel.find({ email: { $in: DEMO_STAFF.map((s) => s.email) } }).select('email phone').lean();
  const base = { phone: '', paidLeaves: 1, extraRate: null, pf: false, uan: '', joinedOn: joined, leftOn: null };
  const terms = [
    { email: 'demo.manager@medbox24.in', name: 'Priya Das', job: 'Manager', payKind: 'month' as const, pay: 1_800_000, weeklyOff: [3], pf: true, uan: '100935512478' },
    { email: 'demo.cashier@medbox24.in', name: 'Sunita Roy', job: 'Cashier', payKind: 'month' as const, pay: 1_200_000, weeklyOff: [0] },
    { email: 'demo.stock@medbox24.in', name: 'Ravi Kumar', job: 'Stock keeper', payKind: 'month' as const, pay: 1_100_000, weeklyOff: [0] },
  ];
  const people: { id: string; off: number[] }[] = [];
  for (const t of terms) {
    const userId = users.find((u) => u.email === t.email)?._id;
    const e = await pay.createEmployee(ctx, actor, { ...base, ...t, userId: userId ? String(userId) : null, phone: users.find((u) => u.email === t.email)?.phone ?? '' });
    people.push({ id: e.id, off: t.weeklyOff });
  }
  const babu = await pay.createEmployee(ctx, actor, { ...base, name: 'Babu Mondal', job: 'Delivery', payKind: 'day', pay: 45_000, weeklyOff: [0], paidLeaves: 0, email: '', userId: null, phone: '98300 61234' });
  people.push({ id: babu.id, off: [0] });

  // A few days that differ, spread over last month and this one; the rest stay present.
  const marks: [number, number, 'absent' | 'half' | 'leave' | 'extra'][] = [[0, 4, 'absent'], [0, 18, 'half'], [1, 9, 'absent'], [1, 10, 'absent'], [1, 23, 'leave'], [2, 6, 'half'], [3, 12, 'absent'], [3, 15, 'absent']];
  for (const m of [last, thisMonth]) {
    for (const [who, d, mark] of marks) {
      const day = `${m}-${String(d).padStart(2, '0')}`;
      const p = people[who];
      if (!p || day > today) continue;
      const off = p.off.includes(new Date(`${day}T00:00:00Z`).getUTCDay());
      if (off === (mark === 'extra')) await pay.mark(ctx, actor, { employeeId: p.id, day, mark }, now).catch(() => undefined);
    }
    // Ravi worked a Sunday: an extra day.
    const sunday = Array.from({ length: 28 }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`).find((d) => d <= today && new Date(`${d}T00:00:00Z`).getUTCDay() === 0);
    if (sunday && people[2]) await pay.mark(ctx, actor, { employeeId: people[2].id, day: sunday, mark: 'extra' }, now).catch(() => undefined);
  }

  // Last month paid on the 1st, by UPI (never drawer cash: the day close of the demo stays its own).
  const sheet = await pay.month(ctx, last, now);
  for (const r of sheet.rows) {
    await pay.pay(ctx, actor, { clientRequestId: randomUUID(), employeeId: r.employee.id, month: last, advanceCut: r.calc.maxCut, expect: r.calc.net, note: '', paymentMode: r.employee.payKind === 'day' ? 'CASH' : 'UPI', fromDrawer: false, date: at(`${thisMonth}-01`) }, now);
  }
  if (people[1]) await pay.advance(ctx, actor, { clientRequestId: randomUUID(), employeeId: people[1].id, amount: 100_000, note: 'Festival', paymentMode: 'CASH', fromDrawer: false, date: at(today) }, now);
}
