import { Types, type ClientSession } from 'mongoose';
import { afterCursor, page, sortOf } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { istDayStart, istIsoDay } from '../../utils/date';
import { fyOf } from '../../utils/fy';
import { inr } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { nextNumber } from '../counters/counter.model';
import { DayCloseModel } from '../dayclose/dayclose.model';
import type { Actor } from '../user/actor';
import { EXPENSE_CATEGORIES, ExpenseModel, type Expense } from './expense.model';
import type { ExpenseInput, ExpenseListQuery, UpdateExpenseInput } from './expenses.validation';

const DAY = 24 * 60 * 60 * 1000;
const SORT = { field: 'date', dir: -1 } as const;

type Lean = Expense & { _id: Types.ObjectId; createdAt?: Date };

function shape(e: Lean) {
  return {
    id: String(e._id),
    expenseNumber: e.expenseNumber,
    date: e.date,
    day: istIsoDay(e.date),
    category: e.category,
    description: e.description,
    amount: e.amount,
    paymentMode: e.paymentMode,
    fromDrawer: e.fromDrawer,
    vendor: e.vendor,
    referenceNumber: e.referenceNumber,
    status: e.status,
    deleteReason: e.deleteReason ?? null,
    deletedBy: e.deletedBy ?? null,
    createdByName: e.createdByName,
    createdAt: e.createdAt,
  };
}

const drawer = (e: { paymentMode: string; fromDrawer: boolean }) => e.paymentMode === 'CASH' && e.fromDrawer;

function notFuture(date: Date) {
  if (date.getTime() > istDayStart(new Date()).getTime()) throw AppError.validation('An expense can’t be in the future', [{ field: 'body.date', message: 'Not in the future' }]);
}

/** A closed day's drawer count is final: drawer cash on it can't be added, changed or removed (PLAN §35.3). */
async function assertOpenDay(t: TenantContext, date: Date, session?: ClientSession) {
  const day = istIsoDay(date);
  if (await DayCloseModel.exists({ shopId: t.shopId, day }).session(session ?? null)) {
    throw AppError.conflict(`${day} is already closed — drawer cash on it can’t change. Pay it from outside the drawer, or date it today.`, { reason: 'DAY_CLOSED' });
  }
}

export async function create(t: TenantContext, actor: Actor, input: ExpenseInput, ip?: string) {
  notFuture(input.date);
  const fromDrawer = input.paymentMode === 'CASH' && input.fromDrawer;
  return once(t.shopId, 'expense', input.clientRequestId, async (session) => {
    if (fromDrawer) await assertOpenDay(t, input.date, session);
    const expenseNumber = await nextNumber(t.shopId, 'expense', input.date, session);
    const [doc] = await ExpenseModel.create(
      [{ shopId: t.shopId, fy: fyOf(input.date), clientRequestId: input.clientRequestId, expenseNumber, date: input.date, category: input.category, description: input.description, amount: input.amount, paymentMode: input.paymentMode, fromDrawer, vendor: input.vendor, referenceNumber: input.referenceNumber, createdBy: new Types.ObjectId(actor.id), createdByName: actor.name }],
      { session },
    );
    if (!doc) throw AppError.internal();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'expenses', entityId: String(doc._id), entityName: expenseNumber, text: `${actor.name} added ${expenseNumber} · ${input.category} · ${inr(input.amount)}${fromDrawer ? ' from the drawer' : ''}`, ip }, session);
    return shape(doc.toObject<Lean>());
  });
}

export async function list(t: TenantContext, q: ExpenseListQuery) {
  const filter: Record<string, unknown> = { shopId: t.shopId, status: 'active' };
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lt: new Date(q.to.getTime() + DAY) } : {}) };
  if (q.category) filter.category = q.category;
  const rows = await ExpenseModel.find({ ...filter, ...afterCursor(q.cursor, SORT) }).sort(sortOf(SORT)).limit(q.limit + 1).lean<Lean[]>();
  const { items, meta } = page(rows, q.limit, (r) => r.date);
  return { items: items.map(shape), meta };
}

export async function get(t: TenantContext, id: string) {
  const e = await ExpenseModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) }).lean<Lean>();
  if (!e) throw AppError.notFound('Expense not found');
  return shape(e);
}

const monthStart = (at: Date, back = 0) => {
  const ist = new Date(at.getTime() + 5.5 * 60 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - back, 1) - 5.5 * 60 * 60 * 1000);
};

/** This month so far vs last month to the same day — rent on the 1st doesn't skew it (sandbox money.js). */
export async function summary(t: TenantContext, now = new Date()) {
  const m0 = monthStart(now);
  const p0 = monthStart(now, 1);
  const dayOfMonth = Math.floor((istDayStart(now).getTime() - m0.getTime()) / DAY);
  const pEnd = new Date(Math.min(p0.getTime() + (dayOfMonth + 1) * DAY, m0.getTime()));
  const [cur, prev, used] = await Promise.all([
    ExpenseModel.aggregate<{ _id: string; total: number; n: number }>([{ $match: { shopId: t.shopId, status: 'active', date: { $gte: m0 } } }, { $group: { _id: '$category', total: { $sum: '$amount' }, n: { $sum: 1 } } }, { $sort: { total: -1 } }]),
    ExpenseModel.aggregate<{ total: number }>([{ $match: { shopId: t.shopId, status: 'active', date: { $gte: p0, $lt: pEnd } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ExpenseModel.distinct('category', { shopId: t.shopId, status: 'active' }),
  ]);
  const month = cur.reduce((s, c) => s + c.total, 0);
  return {
    month,
    entries: cur.reduce((s, c) => s + c.n, 0),
    lastMonthSameDays: prev[0]?.total ?? 0,
    sameDay: dayOfMonth + 1,
    byCategory: cur.map((c) => ({ category: c._id, total: c.total })),
    categories: [...new Set([...EXPENSE_CATEGORIES, ...used.map(String)])],
  };
}

export async function update(t: TenantContext, actor: Actor, id: string, input: UpdateExpenseInput, ip?: string) {
  notFuture(input.date);
  const fromDrawer = input.paymentMode === 'CASH' && input.fromDrawer;
  return inTransaction(async (session) => {
    const doc = await ExpenseModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), status: 'active' }).session(session);
    if (!doc) throw AppError.notFound('Expense not found');
    if (drawer(doc)) await assertOpenDay(t, doc.date, session);
    if (fromDrawer) await assertOpenDay(t, input.date, session);
    const before = { day: istIsoDay(doc.date), category: doc.category, amount: doc.amount, paymentMode: doc.paymentMode, fromDrawer: doc.fromDrawer, description: doc.description };
    doc.set({ date: input.date, category: input.category, description: input.description, amount: input.amount, paymentMode: input.paymentMode, fromDrawer, vendor: input.vendor, referenceNumber: input.referenceNumber });
    await doc.save({ session });
    const after = { day: istIsoDay(input.date), category: input.category, amount: input.amount, paymentMode: input.paymentMode, fromDrawer, description: input.description };
    const what = [
      before.amount !== after.amount ? `${inr(before.amount)} → ${inr(after.amount)}` : '',
      before.category !== after.category ? `${before.category} → ${after.category}` : '',
      before.day !== after.day ? `${before.day} → ${after.day}` : '',
      before.paymentMode !== after.paymentMode || before.fromDrawer !== after.fromDrawer ? `${before.paymentMode}${before.fromDrawer ? ' (drawer)' : ''} → ${after.paymentMode}${fromDrawer ? ' (drawer)' : ''}` : '',
    ].filter(Boolean);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'expenses', entityId: id, entityName: doc.expenseNumber, text: `${actor.name} changed ${doc.expenseNumber}${what.length ? ` · ${what.join(' · ')}` : ''}`, changes: { before, after }, ip }, session);
    return shape(doc.toObject<Lean>());
  });
}

export async function remove(t: TenantContext, actor: Actor, id: string, reason: string, ip?: string) {
  return inTransaction(async (session) => {
    const doc = await ExpenseModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id), status: 'active' }).session(session);
    if (!doc) throw AppError.notFound('Expense not found');
    if (drawer(doc)) await assertOpenDay(t, doc.date, session);
    doc.set({ status: 'deleted', deleteReason: reason, deletedBy: actor.name, deletedAt: new Date() });
    await doc.save({ session });
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'delete', module: 'expenses', entityId: id, entityName: doc.expenseNumber, text: `${actor.name} removed ${doc.expenseNumber} · ${doc.category} · ${inr(doc.amount)} — ${reason}`, ip }, session);
    return shape(doc.toObject<Lean>());
  });
}
