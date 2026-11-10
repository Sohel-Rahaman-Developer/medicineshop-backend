// D114 checks: payroll — who, attendance rules, the month worked out, advance / bonus / salary / PF as expenses, undo.
import { randomUUID } from 'node:crypto';
import { basicOpens, seedBasic } from './lib/basic-plans';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${String(r.status)} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error?.details as { reason?: string } | undefined)?.reason;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-11',
  agree: true,
});

interface Calc { dayRate: number; base: number; missed: number; covered: number; cut: number; extraPay: number; earned: number; bonus: number; gross: number; pfEmployee: number; pfShop: number; advanceDue: number; maxCut: number; advanceCut: number; net: number; counts: Record<string, number> }
interface Row { employee: { id: string; name: string }; calc: Calc; paid: { id: string; amount: number } | null; advanceDue: number }
interface Month { canPay: boolean; rows: Row[]; totals: { toPay: number; paid: number }; pf: { total: number; deposited: number; due: number; dueBy: string; people: number } }
interface Entry { id: string; amount: number; expenseNumber: string | null; advanceCut: number; pfEmployee: number; status: string; mailedTo?: string | null }
interface Exp { id: string; expenseNumber: string; category: string; description: string; amount: number; paymentMode: string; fromDrawer: boolean; source: string | null; status: string }

const IST = 5.5 * 3_600_000;
const todayIso = () => new Date(Date.now() + IST).toISOString().slice(0, 10);

async function main() {
  const h = await startHarness();
  const { RoleModel } = await import('../src/modules/roles/role.model.js');
  const { bringOwnersForward } = await import('../src/modules/roles/roles.service.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { forgetPlanFeatures } = await import('../src/modules/subscription/plan-access.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { EmailJobModel, drainMail } = await import('../src/services/mail-queue.js');
  const { pdfWords } = await import('../src/core/pdf-text.js');

  const owner = await h.signIn('rohit@pay1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    await c.post(`/invitations/${data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? ''}/accept`, { name: email.split('@')[0] });
    c.shopId = shop1;
    return c;
  };
  const manager = await invite('anil@pay1.test', 'manager');
  const cashier = await invite('sunita@pay1.test', 'cashier');

  // The month just over: its salary can be paid. Sundays are its weekly offs.
  const today = todayIso();
  const [ty = 0, tm = 0] = today.split('-').map(Number);
  const M = tm === 1 ? `${String(ty - 1)}-12` : `${String(ty)}-${String(tm - 1).padStart(2, '0')}`;
  const [my = 0, mm = 0] = M.split('-').map(Number);
  const len = new Date(Date.UTC(my, mm, 0)).getUTCDate();
  const days = Array.from({ length: len }, (_, i) => `${M}-${String(i + 1).padStart(2, '0')}`);
  const sunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
  const work = days.filter((d) => !sunday(d));
  const sundays = days.filter(sunday);
  const start = `${String(my - 1)}-04-01`;
  const month = async () => data<Month>(await owner.get(`/payroll/month?month=${M}`));
  const rowOf = async (id: string) => (await month()).rows.find((r) => r.employee.id === id);
  const drawerOut = async () => data<{ cash: { expenses: number } | null }>(await owner.get('/day-close')).cash?.expenses ?? -1;
  const expense = async (n: string | null) => data<Exp[]>(await owner.get('/expenses?limit=100')).find((e) => e.expenseNumber === n);

  section('1. Who can (Owner only, by default) and the plan');
  check('manager and cashier → 403', (await manager.get(`/payroll/month?month=${M}`)).status === 403 && (await cashier.get(`/payroll/month?month=${M}`)).status === 403);
  check('owner → 200 (trial has every feature)', (await owner.get(`/payroll/month?month=${M}`)).status === 200);
  await RoleModel.updateMany({ shopId: shop1, systemKey: 'owner' }, { $unset: { 'permissions.payroll': 1 } });
  check('an Owner role from before payroll → 403…', (await owner.get(`/payroll/month?month=${M}`)).status === 403);
  const moved = await bringOwnersForward();
  const mgr = await RoleModel.findOne({ shopId: shop1, systemKey: 'manager' }).lean();
  check('…the start-up step gives it to Owner roles only, once', moved >= 1 && (await owner.get(`/payroll/month?month=${M}`)).status === 200 && !(mgr?.permissions as Record<string, unknown>).payroll && (await bringOwnersForward()) === 0, String(moved));

  section('2. People');
  const person = (over: Record<string, unknown> = {}) => ({ name: 'Ramesh Das', phone: '98300 55555', job: 'Pharmacist', payKind: 'month', pay: 1_200_000, weeklyOff: [0], paidLeaves: 1, extraRate: null, pf: false, uan: '', joinedOn: start, leftOn: null, ...over });
  const bad = await Promise.all([person({ name: 'R' }), person({ pay: 0 }), person({ uan: '1234' }), person({ leftOn: `${String(my - 1)}-03-01` }), person({ weeklyOff: [0, 1, 2, 3, 4, 5, 6] }), person({ payKind: 'week' })].map((b) => owner.post('/payroll/employees', b)));
  check('short name / no pay / UAN not 12 digits / last day before the first / no working day / unknown pay → 422', bad.every((r) => r.status === 422), bad.map((r) => r.status).join());
  const ramesh = data<{ id: string }>(await owner.post('/payroll/employees', person())).id;
  const meera = data<{ id: string }>(await owner.post('/payroll/employees', person({ name: 'Meera Sen', email: 'Meera.Sen@pay1.test', pay: 2_000_000, weeklyOff: [], paidLeaves: 0, pf: true, uan: '100200300400' }))).id;
  const babu = data<{ id: string }>(await owner.post('/payroll/employees', person({ name: 'Babu (delivery)', job: 'Delivery', payKind: 'day', pay: 50_000, weeklyOff: [], paidLeaves: 0 }))).id;
  check('three people: a monthly pharmacist, a monthly one with PF, a day wage', Boolean(ramesh && meera && babu));

  section('3. Attendance');
  const mark = (employeeId: string, day: string, m: string) => owner.put('/payroll/attendance', { employeeId, day, mark: m });
  const tomorrow = new Date(Date.now() + IST + 86_400_000).toISOString().slice(0, 10);
  check('a day still to come → 422', (await mark(ramesh, tomorrow, 'absent')).status === 422);
  check('Extra day on a working day → 422; Absent on his Sunday → 422', (await mark(ramesh, work[0] ?? '', 'extra')).status === 422 && (await mark(ramesh, sundays[0] ?? '', 'absent')).status === 422);
  check('a day before he joined → 409', (await mark(ramesh, `${String(my - 1)}-03-15`, 'absent')).status === 409);
  const marks = await Promise.all([mark(ramesh, work[0] ?? '', 'absent'), mark(ramesh, work[1] ?? '', 'absent'), mark(ramesh, work[2] ?? '', 'half'), mark(ramesh, sundays[0] ?? '', 'extra'), mark(babu, work[3] ?? '', 'absent')]);
  check('2 absent, a half day and an extra Sunday for Ramesh; Babu absent once', marks.every((r) => r.status === 200), marks.map(code).join());
  await mark(ramesh, work[4] ?? '', 'leave');
  await mark(ramesh, work[4] ?? '', 'present');
  const sheet = data<{ rows: { id: string; mark: string | null; off: boolean }[] }>(await owner.get(`/payroll/day?day=${work[0] ?? ''}`));
  check('the day sheet: Ramesh absent, the others present', sheet.rows.find((r) => r.id === ramesh)?.mark === 'absent' && sheet.rows.find((r) => r.id === meera)?.mark === null && sheet.rows.length === 3);
  const sunSheet = data<{ rows: { id: string; mark: string | null; off: boolean }[] }>(await owner.get(`/payroll/day?day=${sundays[0] ?? ''}`));
  check('his Sunday shows as his weekly off, worked as an extra day', sunSheet.rows.find((r) => r.id === ramesh)?.off === true && sunSheet.rows.find((r) => r.id === ramesh)?.mark === 'extra');
  const audits = await AuditLogModel.find({ shopId: shop1, module: 'payroll', text: /marked Ramesh Das/ }).lean();
  check('each change is in the audit log; back to present says what it was', audits.length === 6 && audits.some((a) => /marked Ramesh Das present .* \(was on paid leave\)/.test(a.text)), audits.map((a) => a.text).join(' | '));

  section('4. The month worked out');
  const r1 = (await rowOf(ramesh))?.calc;
  check('₹12,000 ÷ 30 = ₹400 a day; 2.5 days missed, 1 paid leave → 1.5 days × ₹400 = ₹600 off; Sunday + ₹400 → ₹11,800', r1?.dayRate === 40_000 && r1.missed === 2.5 && r1.covered === 1 && r1.cut === 60_000 && r1.extraPay === 40_000 && r1.earned === 1_180_000, JSON.stringify(r1));
  const b1 = (await rowOf(babu))?.calc;
  check(`Babu: ${String(len)} days − 1 absent at ₹500 = ₹${String((len - 1) * 500)}`, b1?.earned === (len - 1) * 50_000, JSON.stringify(b1));
  const m1 = (await rowOf(meera))?.calc;
  check('Meera ₹20,000 with PF: 12% of ₹15,000 = ₹1,800 kept, the shop adds ₹1,800 → ₹18,200 in hand', m1?.pfEmployee === 180_000 && m1.pfShop === 180_000 && m1.net === 1_820_000, JSON.stringify(m1));

  section('5. Advance: an expense at once, from the drawer');
  const out0 = await drawerOut();
  const advBody = { clientRequestId: randomUUID(), employeeId: ramesh, amount: 200_000, note: 'Rent', paymentMode: 'CASH', fromDrawer: true, date: today };
  const adv = await owner.post('/payroll/advances', advBody);
  const advE = data<Entry>(adv);
  check('₹2,000 advance → 201 with its expense number', adv.status === 201 && /^EXP-/.test(advE.expenseNumber ?? ''), code(adv));
  check('the same request again → 200, nothing doubled', data<Entry>(await owner.post('/payroll/advances', advBody)).id === advE.id);
  const advX = await expense(advE.expenseNumber);
  check('the expense: Salary · "Advance — Ramesh Das · Rent" · from the drawer · made by Payroll', advX?.category === 'Salary' && advX.description === 'Advance — Ramesh Das · Rent' && advX.fromDrawer && advX.source === 'payroll', JSON.stringify(advX));
  check('day close counts the ₹2,000 out of the drawer', (await drawerOut()) === out0 + 200_000);
  const edit = await owner.patch(`/expenses/${advX?.id ?? ''}`, { date: today, category: 'Salary', description: 'x', amount: 1, paymentMode: 'CASH', fromDrawer: true, vendor: '', referenceNumber: '' });
  const drop = await owner.del(`/expenses/${advX?.id ?? ''}`, { reason: 'test' });
  check('Expenses can’t change or remove it: 409 FROM_PAYROLL', edit.status === 409 && drop.status === 409 && reason(drop) === 'FROM_PAYROLL', code(drop));

  section('6. Bonus with the salary, then pay');
  const bon = await owner.post('/payroll/bonuses', { clientRequestId: randomUUID(), employeeId: ramesh, month: M, amount: 100_000, note: 'Diwali', paidNow: false });
  check('₹1,000 bonus added to the month: no expense of its own', bon.status === 201 && data<Entry>(bon).expenseNumber === null, code(bon));
  const r2 = (await rowOf(ramesh))?.calc;
  check('₹11,800 + ₹1,000 = ₹12,800; advance ₹2,000 off → ₹10,800 to pay', r2?.gross === 1_280_000 && r2.advanceCut === 200_000 && r2.net === 1_080_000, JSON.stringify(r2));
  const thisMonth = today.slice(0, 7);
  const early = await owner.post('/payroll/pay', { clientRequestId: randomUUID(), employeeId: ramesh, month: thisMonth, advanceCut: 0, expect: 0, note: '', paymentMode: 'CASH', fromDrawer: true, date: today });
  check('this month isn’t over → 409 MONTH_OPEN', early.status === 409 && reason(early) === 'MONTH_OPEN', code(early));
  const pay = (over: Record<string, unknown> = {}) => owner.post('/payroll/pay', { clientRequestId: randomUUID(), employeeId: ramesh, month: M, advanceCut: 200_000, expect: 1_080_000, note: '', paymentMode: 'CASH', fromDrawer: true, date: today, ...over });
  const stale = await pay({ expect: 1_180_000 });
  check('the amount on screen is old → 409 CHANGED with the right one', stale.status === 409 && reason(stale) === 'CHANGED' && (stale.json.error?.details as { net?: number }).net === 1_080_000, code(stale));
  check('cutting more advance than given → 422', (await pay({ advanceCut: 300_000, expect: 980_000 })).status === 422);
  const paid = await pay();
  const paidE = data<Entry>(paid);
  check('paid ₹10,800 → 201, expense made', paid.status === 201 && paidE.amount === 1_080_000 && paidE.advanceCut === 200_000, code(paid));
  const payX = await expense(paidE.expenseNumber);
  // Written out: en-GB says "Sept" on newer ICU, the app says "Sep".
  const mName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mm - 1] ?? '';
  check(`the expense: Salary · "Salary — Ramesh Das, ${mName} ${String(my)}" · ₹10,800 from the drawer`, payX?.amount === 1_080_000 && payX.description === `Salary — Ramesh Das, ${mName} ${String(my)}` && payX.fromDrawer, JSON.stringify(payX));
  check('day close: ₹2,000 + ₹10,800 out of the drawer', (await drawerOut()) === out0 + 1_280_000);
  const r3 = await rowOf(ramesh);
  check('the month shows him paid; no advance left', r3?.paid?.amount === 1_080_000 && r3.advanceDue === 0);
  check('paid again → 409', (await pay()).status === 409);
  const late = await mark(ramesh, work[5] ?? '', 'absent');
  check('a paid month’s attendance is locked → 409 SALARY_PAID', late.status === 409 && reason(late) === 'SALARY_PAID', code(late));
  const slip = await owner.get(`/payroll/entries/${paidE.id}/pdf`);
  const words = slip.status === 200 ? (await pdfWords(slip.body)).flat().map((w) => w.text).join(' ') : '';
  check('the payslip PDF: Payslip, Ramesh Das, ₹12,000 a month, 1.5 days not paid, advance recovered, net ₹10,800', slip.headers.get('content-type') === 'application/pdf' && /Payslip/.test(words) && words.includes('Ramesh Das') && words.includes('12,000.00') && words.includes('600.00') && words.includes('2,000.00') && words.includes('10,800.00'), `${String(slip.status)} ${words.slice(0, 400)}`);
  check('no email for Ramesh → nothing queued; “Email payslip” → 409 NO_EMAIL', !(await EmailJobModel.exists({ kind: 'payslip', shopId: shop1 })) && reason(await owner.post(`/payroll/entries/${paidE.id}/email`, {})) === 'NO_EMAIL');
  check('the manager can’t read a payslip → 403', (await manager.get(`/payroll/entries/${paidE.id}/pdf`)).status === 403);
  check('a bonus “with the salary” for a paid month → 409', (await owner.post('/payroll/bonuses', { clientRequestId: randomUUID(), employeeId: ramesh, month: M, amount: 10_000, note: '', paidNow: false })).status === 409);
  const advUndo = await owner.del(`/payroll/entries/${advE.id}`, { reason: 'Entered twice' });
  check('undo the advance once a salary cut it → 409 ADVANCE_CUT', advUndo.status === 409 && reason(advUndo) === 'ADVANCE_CUT', code(advUndo));

  section('7. PF: due, deposited, undone in order');
  const mp = await owner.post('/payroll/pay', { clientRequestId: randomUUID(), employeeId: meera, month: M, advanceCut: 0, expect: 1_820_000, note: '', paymentMode: 'BANK', fromDrawer: false, date: today });
  check('Meera paid ₹18,200 by bank; ₹1,800 PF kept', mp.status === 201 && data<Entry>(mp).pfEmployee === 180_000, code(mp));
  const job = await EmailJobModel.findOne({ kind: 'payslip', shopId: shop1 }).lean();
  const att = job?.attachments?.[0];
  check('she has an email: the payslip is queued to it at once, the PDF attached', data<Entry>(mp).mailedTo === 'meera.sen@pay1.test' && job?.to === 'meera.sen@pay1.test' && job.subject === `Payslip · ${mName} ${String(my)} · Shri Ram Medical Store` && att?.contentType === 'application/pdf' && Buffer.from(att.content?.buffer ?? []).subarray(0, 4).toString() === '%PDF' && job.text.includes('₹18,200.00'), JSON.stringify({ to: job?.to, subject: job?.subject, mailed: data<Entry>(mp).mailedTo }));
  const drained = await drainMail(new Date(Date.now() + 60_000));
  check('the mail job sends with its attachment', drained.sent >= 1 && (await EmailJobModel.findById(job?._id).lean())?.status === 'sent', JSON.stringify(drained));
  const again = await owner.post(`/payroll/entries/${data<Entry>(mp).id}/email`, {});
  check('“Email payslip” again → 200, a second mail, audited', again.status === 200 && (await EmailJobModel.countDocuments({ kind: 'payslip', shopId: shop1 })) === 2 && Boolean(await AuditLogModel.exists({ shopId: shop1, module: 'payroll', text: /emailed Meera Sen’s payslip/ })), code(again));
  const pf1 = (await month()).pf;
  const next = mm === 12 ? `${String(my + 1)}-01` : `${String(my)}-${String(mm + 1).padStart(2, '0')}`;
  check(`PF due ₹3,600 (₹1,800 + ₹1,800) by ${next}-15`, pf1.due === 360_000 && pf1.dueBy === `${next}-15` && pf1.people === 1, JSON.stringify(pf1));
  check('depositing another amount → 409', (await owner.post('/payroll/pf', { clientRequestId: randomUUID(), month: M, amount: 180_000, reference: '', date: today })).status === 409);
  const dep = await owner.post('/payroll/pf', { clientRequestId: randomUUID(), month: M, amount: 360_000, reference: 'TRRN 1234567890', date: today });
  const depX = await expense(data<Entry>(dep).expenseNumber);
  check('deposited: a PF expense by bank with the challan number, never drawer cash', dep.status === 201 && depX?.category === 'PF' && depX.paymentMode === 'BANK' && !depX.fromDrawer && depX.amount === 360_000, JSON.stringify(depX));
  check('nothing more due', (await month()).pf.due === 0);
  const mpUndo = await owner.del(`/payroll/entries/${data<Entry>(mp).id}`, { reason: 'Wrong amount' });
  check('undo Meera’s salary while its PF is deposited → 409 PF_DEPOSITED', mpUndo.status === 409 && reason(mpUndo) === 'PF_DEPOSITED', code(mpUndo));
  check('undo the PF deposit → its expense goes', (await owner.del(`/payroll/entries/${data<Entry>(dep).id}`, { reason: 'Wrong month' })).status === 200 && (await expense(data<Entry>(dep).expenseNumber)) === undefined);
  check('then her salary → 200; PF due back to 0', (await owner.del(`/payroll/entries/${data<Entry>(mp).id}`, { reason: 'Wrong amount' })).status === 200 && (await month()).pf.total === 0);

  section('8. Undo Ramesh’s salary');
  check('undo without a reason → 422', (await owner.del(`/payroll/entries/${paidE.id}`, {})).status === 422);
  const undo = await owner.del(`/payroll/entries/${paidE.id}`, { reason: 'Paid the wrong month' });
  check('undo → 200; the expense is removed, the drawer gets ₹10,800 back', undo.status === 200 && (await expense(paidE.expenseNumber)) === undefined && (await drawerOut()) === out0 + 200_000, code(undo));
  check('his attendance opens again; the advance is due again', (await mark(ramesh, work[5] ?? '', 'absent')).status === 200 && (await rowOf(ramesh))?.advanceDue === 200_000);
  check('the advance can be undone now', (await owner.del(`/payroll/entries/${advE.id}`, { reason: 'Entered twice' })).status === 200 && (await drawerOut()) === out0);
  const au = await AuditLogModel.findOne({ shopId: shop1, module: 'payroll', text: /undid Ramesh Das’s salary/ }).lean();
  check('audit: who undid what, and why', /undid Ramesh Das’s salary for .* · ₹10,800\.00 — Paid the wrong month/.test(au?.text ?? ''), au?.text);
  check('undo again → 404', (await owner.del(`/payroll/entries/${paidE.id}`, { reason: 'again' })).status === 404);
  check('an undone salary has no payslip → 404', (await owner.get(`/payroll/entries/${paidE.id}/pdf`)).status === 404);

  section('9. Leaving and removing');
  const rm = await owner.del(`/payroll/employees/${ramesh}`);
  check('remove someone with records → 409 HAS_RECORDS', rm.status === 409 && reason(rm) === 'HAS_RECORDS', code(rm));
  const temp = data<{ id: string }>(await owner.post('/payroll/employees', person({ name: 'Typo Person' }))).id;
  check('added by mistake, no records → removed', (await owner.del(`/payroll/employees/${temp}`)).status === 200);
  const left = await owner.put(`/payroll/employees/${babu}`, person({ name: 'Babu (delivery)', job: 'Delivery', payKind: 'day', pay: 50_000, weeklyOff: [], paidLeaves: 0, leftOn: `${M}-10` }));
  const b2 = (await rowOf(babu))?.calc;
  check('Babu left on the 10th: 10 days − 1 absent = 9 × ₹500', left.status === 200 && b2?.earned === 450_000, `${code(left)} ${JSON.stringify(b2)}`);
  check('…and he is off the sheet after that', !data<{ rows: { id: string }[] }>(await owner.get(`/payroll/day?day=${M}-20`)).rows.some((r) => r.id === babu));

  const leaver = data<{ id: string }>(await owner.post('/payroll/employees', person({ name: 'Kiran Roy', weeklyOff: [], paidLeaves: 0, leftOn: today }))).id;
  const kRow = data<Month>(await owner.get(`/payroll/month?month=${thisMonth}`)).rows.find((r) => r.employee.id === leaver);
  const kDays = Number(today.slice(8));
  const kPay = await owner.post('/payroll/pay', { clientRequestId: randomUUID(), employeeId: leaver, month: thisMonth, advanceCut: 0, expect: kRow?.calc.net ?? -1, note: '', paymentMode: 'BANK', fromDrawer: false, date: today });
  check(`someone leaving today is paid today: ${String(kDays)} days × ₹400 (never above the month)`, kPay.status === 201 && data<Entry>(kPay).amount === Math.min(1_200_000, kDays * 40_000), code(kPay));

  section('9b. App staff on payroll, and Ask knows payroll from staff');
  const { Types } = await import('mongoose');
  const { UserModel } = await import('../src/modules/user/user.model.js');
  const { contextFor } = await import('../src/core/middleware/tenant.js');
  const { runTool } = await import('../src/modules/ask/tools.js');
  type StaffRow = { userId: string; name: string; email: string; job: string };
  const staffNow = async () => data<Month & { staff: StaffRow[] }>(await owner.get(`/payroll/month?month=${thisMonth}`)).staff;
  const st1 = await staffNow();
  check('app logins not on payroll are listed with their role — the manager and the cashier, never the owner', st1.map((x) => x.name).sort().join() === 'anil,sunita' && st1.find((x) => x.name === 'anil')?.job === 'Manager' && st1.every((x) => x.email.endsWith('@pay1.test')), JSON.stringify(st1));
  const anilRow = st1.find((x) => x.name === 'anil');
  const addAnil = await owner.post('/payroll/employees', person({ name: 'Anil Ghosh', userId: anilRow?.userId, email: anilRow?.email }));
  check('one tap adds the manager, linked to his login; he leaves the list', addAnil.status === 201 && data<{ userId: string | null }>(addAnil).userId === anilRow?.userId && (await staffNow()).map((x) => x.name).join() === 'sunita', code(addAnil));
  const twice = await owner.post('/payroll/employees', person({ name: 'Anil again', userId: anilRow?.userId }));
  check('the same login twice → 409 ON_PAYROLL; a login from no staff → 422', twice.status === 409 && reason(twice) === 'ON_PAYROLL' && (await owner.post('/payroll/employees', person({ userId: new Types.ObjectId().toHexString() }))).status === 422, code(twice));
  const people = data<Month>(await owner.get(`/payroll/month?month=${thisMonth}`)).rows.length;
  type Card = { title: string; rows: { label: string; value: string }[]; items: { name: string }[]; note?: string };
  const ask = async (c: typeof owner, text: string) => (r => (r.json.data as { route: string; cards?: Card[] } | undefined))(await c.post('/ask', { text, confirm: true }));
  const a1 = await ask(owner, 'how many employees on payroll?');
  const c1 = a1?.cards?.[0];
  check(`Ask “how many employees on payroll?” → a free card: ${String(people)} people, Anil among them, Sunita named as not on payroll`, a1?.route !== 'ai' && /^Payroll — /.test(c1?.title ?? '') && c1?.rows.find((r) => r.label === 'People on payroll')?.value === String(people) && c1.items.some((i) => i.name === 'Anil Ghosh') && c1.rows.find((r) => r.label === 'Staff not on payroll')?.value === 'sunita', JSON.stringify(a1));
  const a2 = await ask(owner, 'amr payroll a kotoguli employee a6e?');
  check('the same in Roman Bengali (the question that went to AI before) → the payroll card, free', a2?.route !== 'ai' && /^Payroll — /.test(a2?.cards?.[0]?.title ?? ''), JSON.stringify(a2));
  const a4 = await ask(owner, 'salary expense this month');
  check('“salary expense this month” stays the expenses card (every plan has it)', a4?.route !== 'ai' && !/^Payroll/.test(a4?.cards?.[0]?.title ?? '') && /^Expenses/.test(a4?.cards?.[0]?.title ?? ''), JSON.stringify(a4?.cards?.[0]?.title));
  const a3 = await ask(manager, 'payroll this month');
  check('the manager without Payroll → “your role can’t see this”, no numbers', !a3?.cards?.[0]?.rows.length && Boolean(a3?.cards?.[0]?.note), JSON.stringify(a3));
  const ownerId = (await UserModel.findOne({ email: 'rohit@pay1.test' }).lean())?._id ?? new Types.ObjectId();
  const { ctx } = await contextFor(new Types.ObjectId(shop1), ownerId);
  const tool = await runTool({ t: ctx, userId: String(ownerId), now: new Date() }, 'payroll', { month: 'this' });
  const mgrId = (await UserModel.findOne({ email: 'anil@pay1.test' }).lean())?._id ?? new Types.ObjectId();
  const mgrCtx = (await contextFor(new Types.ObjectId(shop1), mgrId)).ctx;
  check('…the manager’s AI gets “your role can’t see this”, no names', !(await runTool({ t: mgrCtx, userId: String(mgrId), now: new Date() }, 'payroll', { month: 'this' })).ok);
  const odd = data<{ id: string }>(await owner.post('/payroll/employees', person({ name: 'Paise Test', pay: 1_000_001, paidLeaves: 0, weeklyOff: [] }))).id;
  const oddRow = data<Month>(await owner.get(`/payroll/month?month=${M}`)).rows.find((r) => r.employee.id === odd);
  const oddPay = await owner.post('/payroll/pay', { clientRequestId: randomUUID(), employeeId: odd, month: M, advanceCut: 0, expect: oddRow?.calc.net ?? -1, note: '', paymentMode: 'BANK', fromDrawer: false, date: today });
  const oddSlip = await owner.get(`/payroll/entries/${data<Entry>(oddPay).id}/pdf`);
  const oddWords = (await pdfWords(oddSlip.body)).flat().map((w) => w.text).join(' ');
  check('₹10,000.01 a month is paid ₹10,000 — the slip shows “Round off −₹0.01”', data<Entry>(oddPay).amount === 1_000_000 && oddWords.includes('Round off') && oddWords.includes('0.01'), `${code(oddPay)} ${oddWords.slice(0, 300)}`);
  check('the AI’s payroll tool reads the people paid, which one has an app login, and who is still off payroll', tool.ok && tool.text.includes('Ramesh Das') && tool.text.includes('"name":"Anil Ghosh","job":"Pharmacist","appLogin":true') && tool.text.includes('"staffNotOnPayroll":["sunita"]') && tool.href === '/payroll', tool.text.slice(0, 300));

  section('10. Another shop sees nothing');
  const other = await h.signIn('gita@pay2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Lake Road Pharmacy'))).id;
  check('their owner opens Ramesh → 404; their month is empty', (await other.get(`/payroll/employees/${ramesh}/month?month=${M}`)).status === 404 && data<Month>(await other.get(`/payroll/month?month=${M}`)).rows.length === 0);
  check('…and can’t mark him → 404', (await other.put('/payroll/attendance', { employeeId: ramesh, day: work[0], mark: 'absent' })).status === 404);

  section('11. Basic: payroll is locked');
  await seedBasic();
  await basicOpens([]);
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { planCode: 'basic-monthly', status: 'active', endDate: new Date(Date.now() + 30 * 86_400_000) } });
  forgetPlanFeatures();
  const lock = await owner.get(`/payroll/month?month=${M}`);
  check('403 PLAN_UPGRADE naming payroll', lock.status === 403 && lock.json.error?.code === 'PLAN_UPGRADE' && (lock.json.error.details as { feature?: string }).feature === 'payroll', code(lock));
  check('the expenses it made stay readable in Expenses', (await owner.get('/expenses')).status === 200);

  await h.close();
  finish();
}

main().catch(crash);
