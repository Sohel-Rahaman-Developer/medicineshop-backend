import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { istDay, paise } from '../../core/zod';
import { istClock, istIsoDay } from '../../utils/date';
import { fyOf } from '../../utils/fy';
import { inr } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { cashOfDay } from '../clinic/clinic.service';
import { CustomerPaymentModel } from '../customers/customer.model';
import { ExpenseModel } from '../expenses/expense.model';
import { OrderModel } from '../orders/order.model';
import { SupplierPaymentModel } from '../purchases/purchase.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import { ShopModel } from '../shops/shop.model';
import type { Actor } from '../user/actor';
import { DayCloseModel } from './dayclose.model';

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;
const oid = (id: string) => new Types.ObjectId(id);
const DENOMS = ['50000', '20000', '10000', '5000', '2000', '1000'] as const;
/** IST midnight of a "YYYY-MM-DD" day. */
const startOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const nextDay = (day: string) => istIsoDay(new Date(startOf(day).getTime() + DAY));
/** Closing before 6 am is still last night's work. */
const LATE_UNTIL = '06:00';

export const statusSchema = z.object({ day: istDay.optional() }).strict();
export const closeSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date'),
    counted: paise('Counted'),
    takenOut: paise('Taken out').default(0),
    note: z.string().trim().max(200).default(''),
    denoms: z.partialRecord(z.enum(DENOMS), z.number().int().min(0).max(100_000)).optional(),
    // Only the very first close: cash already in the drawer when that day began.
    opening: paise('Opening cash').optional(),
  })
  .strict()
  .refine((v) => v.takenOut <= v.counted, { message: 'More than what is in the drawer', path: ['takenOut'] });
export type CloseInput = z.infer<typeof closeSchema>;

const sumOf = <T>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);

/**
 * Every rupee of cash that came into or left the counter since the last close, up to the end of `day` (PLAN §35.3).
 * Days nobody closed are added together: the drawer only ever holds one total. Cash the owner paid from outside the
 * drawer (fromDrawer false) never touches the count. The first close covers its own day; `opening` is then what the
 * counter says was already in the drawer.
 */
export async function cashDay(t: TenantContext, day: string, opening?: number) {
  const prev = await DayCloseModel.findOne({ shopId: t.shopId, dayStart: { $lt: startOf(day) } }).sort({ dayStart: -1 }).select('day leftInDrawer').lean();
  const from = prev ? nextDay(prev.day) : day;
  const d0 = startOf(from);
  const d1 = new Date(startOf(day).getTime() + DAY);
  const inDay = { $gte: d0, $lt: d1 };
  const [billed, cancelledBills, returns, advances, orderRefunds, completed, suppliers, shop, collections, spent, doctors] = await Promise.all([
    SaleModel.find({ shopId: t.shopId, billDate: inDay }).select('payments createdByName').lean(),
    SaleModel.find({ shopId: t.shopId, status: 'cancelled', cancelledAt: inDay }).select('payments').lean(),
    SaleReturnModel.find({ shopId: t.shopId, returnDate: inDay }).select('cashBack').lean(),
    OrderModel.find({ shopId: t.shopId, createdAt: inDay, advanceMode: 'CASH', advance: { $gt: 0 } }).select('advance').lean(),
    OrderModel.find({ shopId: t.shopId, 'refund.at': inDay, 'refund.mode': 'CASH' }).select('refund').lean(),
    OrderModel.find({ shopId: t.shopId, completedAt: inDay, advanceBack: { $gt: 0 } }).select('advanceBack').lean(),
    SupplierPaymentModel.find({ shopId: t.shopId, paymentDate: inDay, paymentMode: 'CASH', fromDrawer: true }).select('amount').lean(),
    ShopModel.findById(t.shopId).select('settings.billing.openingFloat').lean(),
    CustomerPaymentModel.find({ shopId: t.shopId, paymentDate: inDay, paymentMode: 'CASH' }).select('amount').lean(),
    ExpenseModel.find({ shopId: t.shopId, status: 'active', date: inDay, paymentMode: 'CASH', fromDrawer: true }).select('amount').lean(),
    cashOfDay(t, d0, d1),
  ]);
  const pay = (mode: string) => sumOf(billed, (s) => sumOf(s.payments.filter((p) => p.mode === mode), (p) => p.amount));
  const byUser = new Map<string, number>();
  for (const s of billed) {
    const c = sumOf(s.payments.filter((p) => p.mode === 'CASH'), (p) => p.amount);
    if (c) byUser.set(s.createdByName, (byUser.get(s.createdByName) ?? 0) + c);
  }
  const r = {
    day,
    from,
    days: Math.round((d1.getTime() - d0.getTime()) / DAY),
    firstClose: !prev,
    opening: prev ? prev.leftInDrawer : (opening ?? shop?.settings.billing?.openingFloat ?? 0),
    openingFrom: prev?.day ?? null,
    cashSales: pay('CASH'),
    collected: sumOf(collections, (p) => p.amount),
    advances: sumOf(advances, (o) => o.advance),
    refunds: sumOf(returns, (x) => x.cashBack),
    orderRefunds: sumOf(orderRefunds, (o) => o.refund?.amount ?? 0),
    advanceBack: sumOf(completed, (o) => o.advanceBack),
    cancelled: sumOf(cancelledBills, (s) => sumOf(s.payments.filter((p) => p.mode === 'CASH'), (p) => p.amount)),
    suppliers: sumOf(suppliers, (p) => p.amount),
    expenses: sumOf(spent, (e) => e.amount),
    doctorFees: doctors.doctorFees,
    doctorOut: doctors.doctorOut,
    upi: pay('UPI'),
    card: pay('CARD'),
    advanceUsed: pay('ADVANCE'),
    points: pay('POINTS'),
    udhaar: pay('CREDIT'),
    bills: billed.length,
    byUser: [...byUser.entries()].map(([name, cash]) => ({ name, cash })).sort((a, b) => b.cash - a.cash),
  };
  const cashIn = r.cashSales + r.collected + r.advances + r.doctorFees;
  const cashOut = r.refunds + r.orderRefunds + r.advanceBack + r.cancelled + r.suppliers + r.expenses + r.doctorOut;
  return { ...r, cashIn, cashOut, expected: r.opening + cashIn - cashOut };
}

type CloseLean = NonNullable<Awaited<ReturnType<typeof lastClose>>>;
const lastClose = (t: TenantContext) => DayCloseModel.findOne({ shopId: t.shopId }).sort({ dayStart: -1 }).lean();

function shape(c: CloseLean) {
  return {
    id: String(c._id),
    day: c.day,
    from: c.from ?? c.day,
    days: c.days ?? 1,
    opening: c.opening,
    cashSales: c.cashSales,
    collected: c.collected,
    advances: c.advances,
    refunds: c.refunds,
    orderRefunds: c.orderRefunds,
    advanceBack: c.advanceBack,
    cancelled: c.cancelled,
    suppliers: c.suppliers,
    expenses: c.expenses ?? 0,
    doctorFees: c.doctorFees ?? 0,
    doctorOut: c.doctorOut ?? 0,
    cashIn: c.cashIn,
    cashOut: c.cashOut,
    expected: c.expected,
    counted: c.counted,
    diff: c.diff,
    takenOut: c.takenOut,
    leftInDrawer: c.leftInDrawer,
    upi: c.upi,
    card: c.card,
    advanceUsed: c.advanceUsed,
    udhaar: c.udhaar,
    bills: c.bills,
    note: c.note,
    byName: c.byName,
    at: c.at,
  };
}

/**
 * The day to close up to: today — or, before 6 am, yesterday when it is still open and had bills (the counter
 * closing after midnight). `yesterday` is offered while it is still open, for the counter to pick itself.
 */
export async function status(t: TenantContext, asked?: Date) {
  const now = new Date();
  const today = istIsoDay(now);
  const yesterday = istIsoDay(new Date(now.getTime() - DAY));
  const last = await lastClose(t);
  const open = !last || last.day < yesterday;
  let day = asked ? istIsoDay(asked) : today;
  if (!asked && open && istClock(now) < LATE_UNTIL && (await SaleModel.exists({ shopId: t.shopId, billDate: { $gte: startOf(yesterday), $lt: startOf(today) } }))) day = yesterday;
  if (day > today) throw AppError.validation('That day has not come yet', [{ field: 'query.day', message: 'A future day' }]);
  const closed = await DayCloseModel.findOne({ shopId: t.shopId, day }).lean();
  const cash = closed || (last && last.day > day) ? null : await cashDay(t, day);
  return { day, today, isToday: day === today, yesterday: open ? yesterday : null, lastClosed: last?.day ?? null, closed: closed ? shape(closed) : null, cash };
}

export async function history(t: TenantContext) {
  const rows = await DayCloseModel.find({ shopId: t.shopId }).sort({ dayStart: -1 }).limit(30).lean();
  return rows.map(shape);
}

/** Close a day: the server works out what the drawer should hold; a mismatch needs a note (PLAN §35.3). */
export async function close(t: TenantContext, actor: Actor, input: CloseInput, ip?: string) {
  const now = new Date();
  const today = istIsoDay(now);
  if (Number.isNaN(startOf(input.day).getTime()) || istIsoDay(startOf(input.day)) !== input.day) throw AppError.validation('Use a valid date', [{ field: 'body.day', message: 'Use a valid date' }]);
  if (input.day > today) throw AppError.validation('That day has not come yet', [{ field: 'body.day', message: 'A future day' }]);
  return inTransaction(async (session) => {
    const last = await DayCloseModel.findOne({ shopId: t.shopId }).sort({ dayStart: -1 }).select('day').session(session).lean();
    if (last && last.day >= input.day) throw AppError.conflict(last.day === input.day ? `${input.day} is already closed` : `${last.day} is closed already — a day before it can’t be closed now`);
    if (last && input.opening !== undefined) throw AppError.validation('The opening cash comes from the last close', [{ field: 'body.opening', message: 'Only the first close takes it' }]);
    const cash = await cashDay(t, input.day, input.opening);
    const diff = input.counted - cash.expected;
    if (diff && input.note.length < 3) throw AppError.validation('Write why the cash does not match', [{ field: 'body.note', message: 'Write why the cash does not match' }]);
    const [doc] = await DayCloseModel.create(
      [
        {
          shopId: t.shopId,
          fy: fyOf(startOf(input.day)),
          day: input.day,
          from: cash.from,
          days: cash.days,
          dayStart: startOf(input.day),
          opening: cash.opening,
          cashSales: cash.cashSales,
          collected: cash.collected,
          advances: cash.advances,
          refunds: cash.refunds,
          orderRefunds: cash.orderRefunds,
          advanceBack: cash.advanceBack,
          cancelled: cash.cancelled,
          suppliers: cash.suppliers,
          expenses: cash.expenses,
          doctorFees: cash.doctorFees,
          doctorOut: cash.doctorOut,
          cashIn: cash.cashIn,
          cashOut: cash.cashOut,
          expected: cash.expected,
          counted: input.counted,
          diff,
          takenOut: input.takenOut,
          leftInDrawer: input.counted - input.takenOut,
          upi: cash.upi,
          card: cash.card,
          advanceUsed: cash.advanceUsed,
          udhaar: cash.udhaar,
          bills: cash.bills,
          denoms: input.denoms,
          note: input.note,
          by: oid(actor.id),
          byName: actor.name,
          at: now,
        },
      ],
      { session },
    );
    if (!doc) throw AppError.internal();
    const result = diff ? `${diff > 0 ? 'over' : 'short'} ${inr(Math.abs(diff))}${input.note ? `: ${input.note}` : ''}` : 'matched';
    const span = cash.days > 1 ? `${cash.from} to ${input.day} (${String(cash.days)} days)` : input.day;
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'sales', entityId: String(doc._id), entityName: `Day close ${input.day}`, text: `${actor.name} closed ${span} · counted ${inr(input.counted)} vs expected ${inr(cash.expected)} · ${result} · ${inr(input.takenOut)} taken out`, ip }, session);
    const saved = await DayCloseModel.findOne({ shopId: t.shopId, _id: doc._id }).session(session).lean();
    if (!saved) throw AppError.internal();
    return shape(saved);
  });
}
