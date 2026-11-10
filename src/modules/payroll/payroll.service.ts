import { randomUUID } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { logger } from '../../config/logger';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { istIsoDay } from '../../utils/date';
import { inr } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { MembershipModel } from '../memberships/membership.model';
import { RoleModel } from '../roles/role.model';
import { ShopModel } from '../shops/shop.model';
import { UserModel } from '../user/user.model';
import { addExpense, dropExpense } from '../expenses/expenses.service';
import type { Actor } from '../user/actor';
import { lastDayOf, salaryFor, type CalcPerson, type Salary } from './payroll.calc';
import { AttendanceModel, EmployeeModel, PayEntryModel, PayrollSettingModel, type DayBasis, type Employee, type Mark, type PayEntry } from './payroll.model';
import type { AdvanceInput, BonusInput, EmployeeInput, MarkInput, PayInput, PfInput } from './payroll.validation';
import { queueMail } from '../../services/mail-queue';
import { payslipEmail } from '../../services/email-templates';
import { rupees } from '../../core/export';
import { dayLabel } from '../../utils/date';
import { payslipPdf, slipLines } from './payroll.pdf';

const IST = 5.5 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5)) - 1] ?? ''} ${m.slice(0, 4)}`;
const dayName = (d: string) => `${String(Number(d.slice(8)))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? ''}`;
const atIst = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const nextMonth = (m: string) => {
  const [y = 0, mo = 0] = m.split('-').map(Number);
  return mo === 12 ? `${String(y + 1)}-01` : `${String(y)}-${String(mo + 1).padStart(2, '0')}`;
};
const oid = (id: string) => new Types.ObjectId(id);

type Lean = Employee;
type Entry = PayEntry;

function shapeEmployee(e: Lean) {
  return {
    id: String(e._id),
    name: e.name,
    userId: e.userId ? String(e.userId) : null,
    phone: e.phone,
    email: e.email,
    job: e.job,
    payKind: e.payKind,
    pay: e.pay,
    weeklyOff: e.weeklyOff,
    paidLeaves: e.paidLeaves,
    extraRate: e.extraRate ?? null,
    pf: e.pf,
    uan: e.uan,
    joinedOn: istIsoDay(e.joinedOn),
    leftOn: e.leftOn ? istIsoDay(e.leftOn) : null,
  };
}

function shapeEntry(e: Entry) {
  return {
    id: String(e._id),
    kind: e.kind,
    employeeId: e.employeeId ? String(e.employeeId) : null,
    employeeName: e.employeeName,
    month: e.month ?? null,
    day: istIsoDay(e.date),
    amount: e.amount,
    paidNow: e.paidNow,
    paymentMode: e.paymentMode ?? null,
    fromDrawer: e.fromDrawer,
    note: e.note,
    reference: e.reference,
    mailedTo: e.mailedTo ?? null,
    mailedAt: e.mailedAt ?? null,
    advanceCut: e.advanceCut,
    pfEmployee: e.pfEmployee,
    pfShop: e.pfShop,
    status: e.status,
    createdByName: e.createdByName,
  };
}

const person = (e: Lean): CalcPerson => ({ payKind: e.payKind, pay: e.pay, weeklyOff: e.weeklyOff, paidLeaves: e.paidLeaves, extraRate: e.extraRate ?? null, pf: e.pf, joinedOn: istIsoDay(e.joinedOn), leftOn: e.leftOn ? istIsoDay(e.leftOn) : null });
const employedOn = (e: Lean, day: string) => istIsoDay(e.joinedOn) <= day && (!e.leftOn || day <= istIsoDay(e.leftOn));
/** A month's salary is due on its last day, or on the person's last day if they left in it. */
const payableFrom = (e: Lean, month: string) => {
  const left = e.leftOn ? istIsoDay(e.leftOn) : null;
  return left && left.startsWith(month) ? left : lastDayOf(month);
};
const inMonth = (e: Lean, month: string) => istIsoDay(e.joinedOn) <= lastDayOf(month) && (!e.leftOn || istIsoDay(e.leftOn) >= `${month}-01`);

async function dayBasis(t: TenantContext): Promise<DayBasis> {
  return (await PayrollSettingModel.findOne({ shopId: t.shopId }).lean())?.dayBasis ?? 'thirty';
}

async function employee(t: TenantContext, id: string, session?: ClientSession) {
  const e = await EmployeeModel.findOne({ shopId: t.shopId, _id: oid(id) }).session(session ?? null).lean<Lean>();
  if (!e) throw AppError.notFound('Person not found');
  return e;
}

async function salaryOf(t: TenantContext, employeeId: Types.ObjectId, month: string, session?: ClientSession) {
  return PayEntryModel.findOne({ shopId: t.shopId, employeeId, month, kind: 'salary', status: 'active' }).session(session ?? null).lean<Entry>();
}

const paidAlready = (name: string, month: string) => AppError.conflict(`${name}’s salary for ${monthName(month)} is paid — undo the payment to change it`, { reason: 'SALARY_PAID' });

/** Advances given less what salaries have cut, per person. */
async function advancesDue(t: TenantContext, ids: Types.ObjectId[], session?: ClientSession) {
  const rows = await PayEntryModel.find({ shopId: t.shopId, employeeId: { $in: ids }, kind: { $in: ['advance', 'salary'] }, status: 'active' }).select('employeeId kind amount advanceCut').session(session ?? null).lean<Entry[]>();
  const due = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.employeeId);
    due.set(k, (due.get(k) ?? 0) + (r.kind === 'advance' ? r.amount : -r.advanceCut));
  }
  return due;
}

async function marksOf(t: TenantContext, ids: Types.ObjectId[], month: string, session?: ClientSession) {
  const rows = await AttendanceModel.find({ shopId: t.shopId, employeeId: { $in: ids }, day: { $gte: `${month}-01`, $lte: lastDayOf(month) } }).select('employeeId day mark').session(session ?? null).lean();
  const out = new Map<string, Map<string, Mark>>();
  for (const r of rows) {
    const k = String(r.employeeId);
    const m = out.get(k) ?? new Map<string, Mark>();
    m.set(r.day, r.mark);
    out.set(k, m);
  }
  return out;
}

async function bonusesWithSalary(t: TenantContext, ids: Types.ObjectId[], month: string, session?: ClientSession) {
  const rows = await PayEntryModel.find({ shopId: t.shopId, employeeId: { $in: ids }, month, kind: 'bonus', paidNow: false, status: 'active' }).select('employeeId amount').session(session ?? null).lean<Entry[]>();
  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r.employeeId), (out.get(String(r.employeeId)) ?? 0) + r.amount);
  return out;
}

/** One person's month as it stands now. */
async function work(t: TenantContext, e: Lean, month: string, advanceCut: number | null, session?: ClientSession): Promise<Salary> {
  const [basis, marks, bonus, due] = await Promise.all([dayBasis(t), marksOf(t, [e._id], month, session), bonusesWithSalary(t, [e._id], month, session), advancesDue(t, [e._id], session)]);
  return salaryFor(month, person(e), marks.get(String(e._id)) ?? new Map(), { dayBasis: basis, bonusWithSalary: bonus.get(String(e._id)) ?? 0, advanceDue: due.get(String(e._id)) ?? 0, advanceCut });
}

const strip = (s: Salary): Omit<Salary, 'days'> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the day list stays out of saved and listed months
  const { days, ...rest } = s;
  return rest;
};

/** PF the month's paid salaries owe, and what the shop has deposited. */
async function pfOf(t: TenantContext, month: string, session?: ClientSession) {
  const rows = await PayEntryModel.find({ shopId: t.shopId, month, kind: { $in: ['salary', 'pf'] }, status: 'active' }).session(session ?? null).lean<Entry[]>();
  const sal = rows.filter((r) => r.kind === 'salary' && r.pfEmployee > 0);
  const employee = sal.reduce((s, r) => s + r.pfEmployee, 0);
  const shop = sal.reduce((s, r) => s + r.pfShop, 0);
  const deposited = rows.filter((r) => r.kind === 'pf').reduce((s, r) => s + r.amount, 0);
  return { people: sal.length, employee, shop, total: employee + shop, deposited, due: employee + shop - deposited, dueBy: `${nextMonth(month)}-15`, deposits: rows.filter((r) => r.kind === 'pf').map(shapeEntry) };
}

export async function settings(t: TenantContext) {
  return { dayBasis: await dayBasis(t) };
}

export async function saveSettings(t: TenantContext, actor: Actor, basis: DayBasis, ip?: string) {
  const before = await dayBasis(t);
  await PayrollSettingModel.updateOne({ shopId: t.shopId }, { $set: { dayBasis: basis } }, { upsert: true });
  if (before !== basis) await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'payroll', entityName: 'Payroll settings', text: `${actor.name} set a day’s pay to ${basis === 'thirty' ? 'the month ÷ 30' : 'the month ÷ its days'}`, ip });
  return { dayBasis: basis };
}

/** Staff with an app login who are not on payroll yet — the owner adds them in one tap (the owner left out). */
async function staffOffPayroll(t: TenantContext) {
  const [members, linked, shop] = await Promise.all([
    MembershipModel.find({ shopId: t.shopId, status: 'active' }).select('userId roleId designation').lean(),
    EmployeeModel.distinct('userId', { shopId: t.shopId, userId: { $type: 'objectId' } }),
    ShopModel.findById(t.shopId).select('ownerUserId').lean(),
  ]);
  const on = new Set(linked.map(String));
  const left = members.filter((m) => !on.has(String(m.userId)) && !shop?.ownerUserId.equals(m.userId));
  if (!left.length) return [];
  const [users, roles] = await Promise.all([UserModel.find({ _id: { $in: left.map((m) => m.userId) } }).select('name email phone').lean(), RoleModel.find({ shopId: t.shopId, _id: { $in: left.map((m) => m.roleId) } }).select('name').lean()]);
  return left.map((m) => {
    const u = users.find((x) => x._id.equals(m.userId));
    return { userId: String(m.userId), name: u?.name || u?.email || '', email: u?.email ?? '', phone: u?.phone ?? '', job: m.designation || (roles.find((r) => r._id.equals(m.roleId))?.name ?? '') };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Everyone who worked here in the month, each with the month worked out (or as paid). */
export async function month(t: TenantContext, m: string, now = new Date()) {
  const start = atIst(`${m}-01`);
  const end = atIst(`${nextMonth(m)}-01`);
  const people = await EmployeeModel.find({ shopId: t.shopId, joinedOn: { $lt: end }, $or: [{ leftOn: null }, { leftOn: { $gte: start } }] }).sort({ name: 1 }).lean<Lean[]>();
  const ids = people.map((p) => p._id);
  const [basis, marks, bonus, due, salaries, pf] = await Promise.all([
    dayBasis(t),
    marksOf(t, ids, m),
    bonusesWithSalary(t, ids, m),
    advancesDue(t, ids),
    PayEntryModel.find({ shopId: t.shopId, month: m, kind: 'salary', status: 'active' }).lean<Entry[]>(),
    pfOf(t, m),
  ]);
  const paid = new Map(salaries.map((s) => [String(s.employeeId), s]));
  const rows = people.map((e) => {
    const k = String(e._id);
    const p = paid.get(k);
    const calc = salaryFor(m, person(e), marks.get(k) ?? new Map(), { dayBasis: basis, bonusWithSalary: bonus.get(k) ?? 0, advanceDue: due.get(k) ?? 0, advanceCut: null });
    return { employee: shapeEmployee(e), calc: p ? (p.calc as Omit<Salary, 'days'>) : strip(calc), paid: p ? shapeEntry(p) : null, advanceDue: due.get(k) ?? 0 };
  });
  const today = istIsoDay(now);
  return {
    month: m,
    staff: await staffOffPayroll(t),
    today,
    dayBasis: basis,
    canPay: today >= lastDayOf(m),
    rows,
    totals: { toPay: rows.filter((r) => !r.paid).reduce((s, r) => s + r.calc.net, 0), paid: rows.reduce((s, r) => s + (r.paid?.amount ?? 0), 0), people: rows.length },
    pf,
  };
}

/** One person's month day by day, with the money given in it. */
export async function personMonth(t: TenantContext, id: string, m: string, now = new Date()) {
  const e = await employee(t, id);
  const [paid, entries] = await Promise.all([salaryOf(t, e._id, m), PayEntryModel.find({ shopId: t.shopId, employeeId: e._id, status: 'active', $or: [{ kind: 'advance' }, { kind: 'bonus', month: m }] }).sort({ date: -1, _id: -1 }).lean<Entry[]>()]);
  const calc = await work(t, e, m, paid ? paid.advanceCut : null);
  return {
    employee: shapeEmployee(e),
    month: m,
    today: istIsoDay(now),
    canPay: istIsoDay(now) >= payableFrom(e, m) && inMonth(e, m),
    calc: paid ? { ...(paid.calc as Omit<Salary, 'days'>), days: calc.days } : calc,
    paid: paid ? shapeEntry(paid) : null,
    advances: entries.filter((x) => x.kind === 'advance').map(shapeEntry),
    bonuses: entries.filter((x) => x.kind === 'bonus').map(shapeEntry),
  };
}

/** The attendance sheet for one day: everyone working here then. */
export async function day(t: TenantContext, d: string) {
  const at = atIst(d);
  const people = await EmployeeModel.find({ shopId: t.shopId, joinedOn: { $lte: at }, $or: [{ leftOn: null }, { leftOn: { $gte: at } }] }).sort({ name: 1 }).lean<Lean[]>();
  const ids = people.map((p) => p._id);
  const [marks, paid] = await Promise.all([AttendanceModel.find({ shopId: t.shopId, employeeId: { $in: ids }, day: d }).lean(), PayEntryModel.find({ shopId: t.shopId, employeeId: { $in: ids }, month: d.slice(0, 7), kind: 'salary', status: 'active' }).select('employeeId').lean<Entry[]>()]);
  const mark = new Map(marks.map((x) => [String(x.employeeId), x.mark]));
  const locked = new Set(paid.map((p) => String(p.employeeId)));
  const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
  return { day: d, rows: people.map((e) => ({ id: String(e._id), name: e.name, job: e.job, off: e.weeklyOff.includes(weekday), mark: mark.get(String(e._id)) ?? null, locked: locked.has(String(e._id)) })) };
}

const MARK_TEXT: Record<Mark | 'present', string> = { present: 'present', absent: 'absent', half: 'on a half day', leave: 'on paid leave', extra: 'on an extra day' };

export async function mark(t: TenantContext, actor: Actor, input: MarkInput, now = new Date(), ip?: string) {
  if (input.day > istIsoDay(now)) throw AppError.validation('Attendance can’t be marked for a day still to come', [{ field: 'body.day', message: 'Not in the future' }]);
  return inTransaction(async (session) => {
    const e = await employee(t, input.employeeId, session);
    const when = dayName(input.day);
    if (!employedOn(e, input.day)) throw AppError.conflict(`${e.name} wasn’t working here on ${when}`);
    if (await salaryOf(t, e._id, input.day.slice(0, 7), session)) throw paidAlready(e.name, input.day.slice(0, 7));
    const off = e.weeklyOff.includes(new Date(`${input.day}T00:00:00Z`).getUTCDay());
    if (input.mark === 'extra' && !off) throw AppError.validation('Extra day is for a weekly off — this is a working day');
    if (off && input.mark !== 'extra' && input.mark !== 'present') throw AppError.validation(`This is ${e.name}’s weekly off — mark Extra day if they worked`);
    const was = (await AttendanceModel.findOne({ shopId: t.shopId, employeeId: e._id, day: input.day }).session(session).lean())?.mark ?? 'present';
    if (input.mark === 'present') await AttendanceModel.deleteOne({ shopId: t.shopId, employeeId: e._id, day: input.day }, { session });
    else await AttendanceModel.updateOne({ shopId: t.shopId, employeeId: e._id, day: input.day }, { $set: { mark: input.mark, byName: actor.name } }, { upsert: true, session });
    if (was !== input.mark) await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'payroll', entityId: String(e._id), entityName: e.name, text: `${actor.name} marked ${e.name} ${MARK_TEXT[input.mark]} on ${dayName(input.day)}${was === 'present' ? '' : ` (was ${MARK_TEXT[was]})`}`, ip }, session);
    return { id: String(e._id), day: input.day, mark: input.mark === 'present' ? null : input.mark, off };
  });
}

export async function createEmployee(t: TenantContext, actor: Actor, input: EmployeeInput, ip?: string) {
  const userId = input.userId ? oid(input.userId) : undefined;
  if (userId) {
    if (!(await MembershipModel.exists({ shopId: t.shopId, userId, status: 'active' }))) throw AppError.validation('That person is not on this shop’s staff', [{ field: 'body.userId', message: 'Not on the staff' }]);
    const already = await EmployeeModel.findOne({ shopId: t.shopId, userId }).select('name').lean();
    if (already) throw AppError.conflict(`${already.name} is already on payroll`, { reason: 'ON_PAYROLL' });
  }
  const [doc] = await EmployeeModel.create([{ shopId: t.shopId, ...input, userId, extraRate: input.extraRate ?? undefined, leftOn: input.leftOn ?? undefined }]);
  if (!doc) throw AppError.internal();
  const e = doc.toObject<Lean>();
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'payroll', entityId: String(e._id), entityName: e.name, text: `${actor.name} added ${e.name} · ${inr(e.pay)} a ${e.payKind}${e.pf ? ' · PF' : ''}`, ip });
  return shapeEmployee(e);
}

export async function updateEmployee(t: TenantContext, actor: Actor, id: string, input: EmployeeInput, ip?: string) {
  return inTransaction(async (session) => {
    const e = await employee(t, id, session);
    // A paid month stays inside the dates: its salary was worked out on them.
    const paid = await PayEntryModel.find({ shopId: t.shopId, employeeId: e._id, kind: 'salary', status: 'active' }).select('month').session(session).lean<Entry[]>();
    const from = istIsoDay(input.joinedOn);
    const to = input.leftOn ? istIsoDay(input.leftOn) : null;
    const outside = paid.find((p) => p.month && (lastDayOf(p.month) < from || (to !== null && `${p.month}-01` > to)));
    if (outside?.month) throw AppError.conflict(`${monthName(outside.month)} is paid — the dates must keep it in`, { reason: 'SALARY_PAID' });
    // The app login link is set when added and never moves to someone else.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, ...fields } = input;
    await EmployeeModel.updateOne({ shopId: t.shopId, _id: e._id }, { $set: { ...fields, extraRate: input.extraRate ?? undefined, leftOn: input.leftOn ?? undefined }, ...(input.extraRate === null || input.leftOn === null ? { $unset: { ...(input.extraRate === null ? { extraRate: 1 } : {}), ...(input.leftOn === null ? { leftOn: 1 } : {}) } } : {}) }, { session });
    const what = [e.pay !== input.pay || e.payKind !== input.payKind ? `pay ${inr(e.pay)} a ${e.payKind} → ${inr(input.pay)} a ${input.payKind}` : '', e.pf !== input.pf ? `PF ${input.pf ? 'on' : 'off'}` : '', !e.leftOn && to ? `last day ${dayName(to)}` : ''].filter(Boolean);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'payroll', entityId: id, entityName: input.name, text: `${actor.name} changed ${input.name}${what.length ? ` · ${what.join(' · ')}` : ''}`, ip }, session);
    return shapeEmployee({ ...e, ...fields, extraRate: input.extraRate ?? undefined, leftOn: input.leftOn ?? undefined });
  });
}

export async function removeEmployee(t: TenantContext, actor: Actor, id: string, ip?: string) {
  const e = await employee(t, id);
  const [att, money] = await Promise.all([AttendanceModel.exists({ shopId: t.shopId, employeeId: e._id }), PayEntryModel.exists({ shopId: t.shopId, employeeId: e._id })]);
  if (att || money) throw AppError.conflict(`${e.name} has attendance or pay on record — set a last day instead`, { reason: 'HAS_RECORDS' });
  await EmployeeModel.deleteOne({ shopId: t.shopId, _id: e._id });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'delete', module: 'payroll', entityId: id, entityName: e.name, text: `${actor.name} removed ${e.name} (added by mistake)`, ip });
  return shapeEmployee(e);
}

const notFuture = (date: Date, now: Date) => {
  if (istIsoDay(date) > istIsoDay(now)) throw AppError.validation('Money can’t be paid on a day still to come', [{ field: 'body.date', message: 'Not in the future' }]);
};

/** The expense for money paid out, linked back to its entry. */
const expenseFor = (t: TenantContext, actor: Actor, entryId: Types.ObjectId, o: { date: Date; category: string; description: string; amount: number; paymentMode: 'CASH' | 'UPI' | 'CARD' | 'BANK'; fromDrawer: boolean; vendor: string; reference?: string }, session: ClientSession, ip?: string) =>
  addExpense(t, actor, { clientRequestId: randomUUID(), date: o.date, category: o.category, description: o.description, amount: o.amount, paymentMode: o.paymentMode, fromDrawer: o.fromDrawer, vendor: o.vendor, referenceNumber: o.reference ?? '', source: { kind: 'payroll', id: entryId } }, session, ip);

export async function advance(t: TenantContext, actor: Actor, input: AdvanceInput, now = new Date(), ip?: string) {
  notFuture(input.date, now);
  return once(t.shopId, 'payroll', input.clientRequestId, async (session) => {
    const e = await employee(t, input.employeeId, session);
    const when = dayName(istIsoDay(input.date));
    if (!employedOn(e, istIsoDay(input.date))) throw AppError.conflict(`${e.name} wasn’t working here on ${when}`);
    const _id = new Types.ObjectId();
    const fromDrawer = input.paymentMode === 'CASH' && input.fromDrawer;
    const ex = await expenseFor(t, actor, _id, { date: input.date, category: 'Salary', description: `Advance — ${e.name}${input.note ? ` · ${input.note}` : ''}`, amount: input.amount, paymentMode: input.paymentMode, fromDrawer, vendor: e.name }, session, ip);
    const [doc] = await PayEntryModel.create([{ _id, shopId: t.shopId, kind: 'advance', employeeId: e._id, employeeName: e.name, date: input.date, amount: input.amount, paymentMode: input.paymentMode, fromDrawer, note: input.note, expenseId: oid(ex.id), createdByName: actor.name }], { session });
    if (!doc) throw AppError.internal();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'payroll', entityId: String(e._id), entityName: e.name, text: `${actor.name} gave ${e.name} an advance of ${inr(input.amount)} · ${ex.expenseNumber}`, ip }, session);
    return { ...shapeEntry(doc.toObject<Entry>()), expenseNumber: ex.expenseNumber };
  });
}

export async function bonus(t: TenantContext, actor: Actor, input: BonusInput, now = new Date(), ip?: string) {
  const date = input.paidNow && input.date ? input.date : atIst(istIsoDay(now));
  notFuture(date, now);
  return once(t.shopId, 'payroll', input.clientRequestId, async (session) => {
    const e = await employee(t, input.employeeId, session);
    if (!inMonth(e, input.month)) throw AppError.conflict(`${e.name} wasn’t working here in ${monthName(input.month)}`);
    if (!input.paidNow && (await salaryOf(t, e._id, input.month, session))) throw AppError.conflict(`${e.name}’s salary for ${monthName(input.month)} is paid — give the bonus now instead`, { reason: 'SALARY_PAID' });
    const _id = new Types.ObjectId();
    const mode = input.paymentMode ?? 'CASH';
    const fromDrawer = input.paidNow && mode === 'CASH' && input.fromDrawer;
    const ex = input.paidNow ? await expenseFor(t, actor, _id, { date, category: 'Salary', description: `Bonus — ${e.name}, ${monthName(input.month)}${input.note ? ` · ${input.note}` : ''}`, amount: input.amount, paymentMode: mode, fromDrawer, vendor: e.name }, session, ip) : null;
    const [doc] = await PayEntryModel.create([{ _id, shopId: t.shopId, kind: 'bonus', employeeId: e._id, employeeName: e.name, month: input.month, date, amount: input.amount, paidNow: input.paidNow, paymentMode: input.paidNow ? mode : undefined, fromDrawer, note: input.note, expenseId: ex ? oid(ex.id) : undefined, createdByName: actor.name }], { session });
    if (!doc) throw AppError.internal();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'payroll', entityId: String(e._id), entityName: e.name, text: `${actor.name} gave ${e.name} a bonus of ${inr(input.amount)} for ${monthName(input.month)}${ex ? ` · ${ex.expenseNumber}` : ' · with the salary'}`, ip }, session);
    return { ...shapeEntry(doc.toObject<Entry>()), expenseNumber: ex?.expenseNumber ?? null };
  });
}

export async function pay(t: TenantContext, actor: Actor, input: PayInput, now = new Date(), ip?: string) {
  notFuture(input.date, now);
  return once(t.shopId, 'payroll', input.clientRequestId, async (session) => {
    const e = await employee(t, input.employeeId, session);
    if (!inMonth(e, input.month)) throw AppError.conflict(`${e.name} wasn’t working here in ${monthName(input.month)}`);
    if (istIsoDay(now) < payableFrom(e, input.month)) {
      const when = dayName(payableFrom(e, input.month));
      throw AppError.conflict(`${monthName(input.month)} isn’t over yet — its salary can be paid from ${when}`, { reason: 'MONTH_OPEN' });
    }
    if (await salaryOf(t, e._id, input.month, session)) throw AppError.conflict(`${e.name}’s salary for ${monthName(input.month)} is already paid`, { reason: 'SALARY_PAID' });
    const calc = await work(t, e, input.month, input.advanceCut, session);
    if (input.advanceCut > calc.maxCut) throw AppError.validation(`At most ${inr(calc.maxCut)} of the advance can be cut this month`, [{ field: 'body.advanceCut', message: `At most ${inr(calc.maxCut)}` }]);
    if (calc.net !== input.expect) throw AppError.conflict(`The amount changed since you opened it — it is ${inr(calc.net)} now. Check it and pay again.`, { reason: 'CHANGED', net: calc.net });
    const _id = new Types.ObjectId();
    const fromDrawer = input.paymentMode === 'CASH' && input.fromDrawer;
    const ex = calc.net > 0 ? await expenseFor(t, actor, _id, { date: input.date, category: 'Salary', description: `Salary — ${e.name}, ${monthName(input.month)}${input.note ? ` · ${input.note}` : ''}`, amount: calc.net, paymentMode: input.paymentMode, fromDrawer, vendor: e.name }, session, ip) : null;
    const [doc] = await PayEntryModel.create([{ _id, shopId: t.shopId, kind: 'salary', employeeId: e._id, employeeName: e.name, month: input.month, date: input.date, amount: calc.net, paymentMode: input.paymentMode, fromDrawer, note: input.note, expenseId: ex ? oid(ex.id) : undefined, advanceCut: calc.advanceCut, pfEmployee: calc.pfEmployee, pfShop: calc.pfShop, calc: strip(calc), createdByName: actor.name }], { session });
    if (!doc) throw AppError.internal();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'payroll', entityId: String(e._id), entityName: e.name, text: `${actor.name} paid ${e.name} ${inr(calc.net)} for ${monthName(input.month)}${calc.advanceCut ? ` (advance ${inr(calc.advanceCut)} cut)` : ''}${calc.pfEmployee ? ` (PF ${inr(calc.pfEmployee)} kept)` : ''}${ex ? ` · ${ex.expenseNumber}` : ''}`, ip }, session);
    return { ...shapeEntry(doc.toObject<Entry>()), expenseNumber: ex?.expenseNumber ?? null };
  });
}

export async function depositPf(t: TenantContext, actor: Actor, input: PfInput, now = new Date(), ip?: string) {
  notFuture(input.date, now);
  return once(t.shopId, 'payroll', input.clientRequestId, async (session) => {
    const pf = await pfOf(t, input.month, session);
    if (pf.due <= 0) throw AppError.conflict(`No PF is due for ${monthName(input.month)}`, { reason: 'NOTHING_DUE' });
    if (input.amount !== pf.due) throw AppError.conflict(`PF due for ${monthName(input.month)} is ${inr(pf.due)} now — check it and save again`, { reason: 'CHANGED', due: pf.due });
    const _id = new Types.ObjectId();
    const ex = await expenseFor(t, actor, _id, { date: input.date, category: 'PF', description: `PF — ${monthName(input.month)} (${String(pf.people)} ${pf.people === 1 ? 'person' : 'people'})`, amount: pf.due, paymentMode: 'BANK', fromDrawer: false, vendor: 'EPFO', reference: input.reference }, session, ip);
    const [doc] = await PayEntryModel.create([{ _id, shopId: t.shopId, kind: 'pf', month: input.month, date: input.date, amount: pf.due, paymentMode: 'BANK', reference: input.reference, expenseId: oid(ex.id), createdByName: actor.name }], { session });
    if (!doc) throw AppError.internal();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'payroll', entityName: `PF ${monthName(input.month)}`, text: `${actor.name} deposited PF ${inr(pf.due)} for ${monthName(input.month)}${input.reference ? ` · ${input.reference}` : ''} · ${ex.expenseNumber}`, ip }, session);
    return { ...shapeEntry(doc.toObject<Entry>()), expenseNumber: ex.expenseNumber };
  });
}

const KIND_TEXT: Record<Entry['kind'], string> = { advance: 'advance', bonus: 'bonus', salary: 'salary', pf: 'PF deposit' };

/** Undo: the entry stays (removed, with the reason) and its expense goes. */
export async function removeEntry(t: TenantContext, actor: Actor, id: string, reason: string, ip?: string) {
  return inTransaction(async (session) => {
    const x = await PayEntryModel.findOne({ shopId: t.shopId, _id: oid(id), status: 'active' }).session(session).lean<Entry>();
    if (!x) throw AppError.notFound('Not found — it may be undone already');
    if (x.kind === 'advance' && x.employeeId) {
      const due = (await advancesDue(t, [x.employeeId], session)).get(String(x.employeeId)) ?? 0;
      if (due < x.amount) {
        const cut = x.amount - due;
        throw AppError.conflict(`${inr(cut)} of this advance is already cut from a salary — undo that salary first`, { reason: 'ADVANCE_CUT' });
      }
    }
    if (x.kind === 'bonus' && !x.paidNow && x.employeeId && x.month && (await salaryOf(t, x.employeeId, x.month, session))) throw paidAlready(x.employeeName, x.month);
    if (x.kind === 'salary' && x.month && x.pfEmployee > 0) {
      const pf = await pfOf(t, x.month, session);
      if (pf.deposited > pf.total - x.pfEmployee - x.pfShop) throw AppError.conflict(`PF for ${monthName(x.month)} is deposited — undo the PF deposit first`, { reason: 'PF_DEPOSITED' });
    }
    if (x.expenseId) await dropExpense(t, actor, x.expenseId, `Payroll: ${reason}`, session, ip);
    await PayEntryModel.updateOne({ shopId: t.shopId, _id: x._id }, { $set: { status: 'removed', removeReason: reason, removedBy: actor.name } }, { session });
    const who = x.employeeName ? `${x.employeeName}’s ` : '';
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'delete', module: 'payroll', entityId: x.employeeId ? String(x.employeeId) : id, entityName: x.employeeName || KIND_TEXT[x.kind], text: `${actor.name} undid ${who}${KIND_TEXT[x.kind]}${x.month ? ` for ${monthName(x.month)}` : ''} · ${inr(x.amount)} — ${reason}`, ip }, session);
    return { ...shapeEntry(x), status: 'removed' as const };
  });
}

const MODE_NAME: Record<string, string> = { CASH: 'cash', UPI: 'UPI', CARD: 'card', BANK: 'bank transfer' };

/** D114: the payslip PDF to the person's email, through the mail queue (retried; the shop sees when it went). */
export async function mailPayslip(t: TenantContext, actor: Actor, id: string, ip?: string) {
  const s = await payslipPdf(t, id);
  if (!s.e.email) throw AppError.conflict(`Add ${s.e.name}’s email first`, { reason: 'NO_EMAIL' });
  const m = payslipEmail({ shop: s.shopName, name: s.e.name, month: monthName(s.month), net: rupees(s.x.amount), day: dayLabel(s.x.date), mode: MODE_NAME[s.x.paymentMode ?? ''] ?? 'cash', lines: slipLines(s.e, s.c, s.month).map(([item, how, amt]) => [`${item} · ${how}`, rupees(amt)]) });
  await queueMail({ kind: 'payslip', shopId: t.shopId, to: s.e.email, ...m, attachments: [{ filename: `${s.name}.pdf`, contentType: 'application/pdf', content: s.pdf }] });
  const at = new Date();
  await PayEntryModel.updateOne({ shopId: t.shopId, _id: s.x._id }, { $set: { mailedTo: s.e.email, mailedAt: at } });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'payroll', entityId: String(s.e._id), entityName: s.e.name, text: `${actor.name} emailed ${s.e.name}’s payslip for ${monthName(s.month)} to ${s.e.email}`, ip });
  return { mailedTo: s.e.email, mailedAt: at };
}

/** After a salary is paid: the payslip goes by itself when the person has an email (never from the demo shop). */
export async function mailIfEmail(t: TenantContext, actor: Actor, id: string, ip?: string) {
  if (t.demo) return null;
  const x = await PayEntryModel.findOne({ shopId: t.shopId, _id: oid(id) }).select('employeeId').lean<Entry>();
  const has = x?.employeeId ? await EmployeeModel.exists({ shopId: t.shopId, _id: x.employeeId, email: { $ne: '' } }) : null;
  if (!has) return null;
  try {
    return await mailPayslip(t, actor, id, ip);
  } catch (err) {
    logger.error({ err, entryId: id }, 'Payslip email could not be queued');
    return null;
  }
}
