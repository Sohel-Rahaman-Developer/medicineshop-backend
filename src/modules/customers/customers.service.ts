import { Types, type ClientSession } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { fyOf } from '../../utils/fy';
import { inr } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { nextNumber } from '../counters/counter.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import type { Actor } from '../user/actor';
import { CustomerModel, CustomerPaymentModel, DoctorModel } from './customer.model';
import type { CollectInput, CustomerInput, CustomerListQuery, DoctorInput, UpdateCustomerInput } from './customers.validation';

const oid = (id: string) => new Types.ObjectId(id);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type CustomerLean = NonNullable<Awaited<ReturnType<typeof findCustomer>>>;
const findCustomer = (t: TenantContext, id: string, session?: ClientSession) => CustomerModel.findOne({ shopId: t.shopId, _id: oid(id) }).session(session ?? null).lean();

async function load(t: TenantContext, id: string, session?: ClientSession) {
  const c = await findCustomer(t, id, session);
  if (!c) throw AppError.notFound('Customer not found');
  return c;
}

export function shape(c: CustomerLean) {
  return {
    id: String(c._id),
    name: c.name,
    phone: c.phone,
    email: c.email,
    dob: c.dob ?? null,
    gender: c.gender,
    address: c.address,
    gstin: c.gstin,
    businessName: c.businessName,
    whatsappOptIn: c.whatsappOptIn,
    smsOptIn: c.smsOptIn,
    emailOptIn: c.emailOptIn,
    totalSpend: c.totalSpend,
    visitCount: c.visitCount,
    firstVisit: c.firstVisit ?? null,
    lastVisit: c.lastVisit ?? null,
    creditBalance: c.creditBalance,
    creditLimit: c.creditLimit,
    loyaltyPoints: c.loyaltyPoints,
    tier: c.tier,
    chronicConditions: c.chronicConditions,
    notes: c.notes,
    status: c.status,
    version: (c as { version?: number }).version ?? 0,
    createdAt: (c as { createdAt?: Date }).createdAt ?? null,
  };
}

export async function list(t: TenantContext, q: CustomerListQuery) {
  const filter: Record<string, unknown> = { shopId: t.shopId };
  if (q.q) {
    const digits = q.q.replace(/\D/g, '');
    filter.$or = [{ nameLower: { $regex: escape(q.q.toLowerCase()) } }, ...(digits.length >= 3 ? [{ phone: { $regex: escape(digits) } }] : [])];
  }
  if (q.filter === 'udhaar') filter.creditBalance = { $gt: 0 };
  if (q.filter === 'overLimit') filter.$expr = { $and: [{ $gt: ['$creditLimit', 0] }, { $gt: ['$creditBalance', '$creditLimit'] }] };
  // Udhaar lists put the biggest dues first; everyone else newest first.
  const sort = q.filter === 'all' ? { field: 'createdAt', dir: -1 as const } : { field: 'creditBalance', dir: -1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await CustomerModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter)
    .sort({ [sort.field]: -1, _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const { items, meta } = page(rows, q.limit, (r) => (sort.field === 'createdAt' ? ((r as { createdAt?: Date }).createdAt ?? new Date(0)) : r.creditBalance));
  return { items: items.map(shape), meta };
}

/** Udhaar owed to the shop now: customers, total, and how many are over their limit. */
export async function summary(t: TenantContext) {
  const [r] = await CustomerModel.aggregate<{ customers: number; owing: number; udhaar: number; over: number }>([
    { $match: { shopId: t.shopId } },
    { $group: { _id: null, customers: { $sum: 1 }, owing: { $sum: { $cond: [{ $gt: ['$creditBalance', 0] }, 1, 0] } }, udhaar: { $sum: '$creditBalance' }, over: { $sum: { $cond: [{ $and: [{ $gt: ['$creditLimit', 0] }, { $gt: ['$creditBalance', '$creditLimit'] }] }, 1, 0] } } } },
  ]);
  return { customers: r?.customers ?? 0, owing: r?.owing ?? 0, udhaar: r?.udhaar ?? 0, overLimit: r?.over ?? 0 };
}

const isDuplicate = (err: unknown) => (err as { code?: number }).code === 11000;

/** A phone is one customer per shop: the same number again is a 409 that names the one already there. */
export async function create(t: TenantContext, actor: Actor, input: CustomerInput, ip?: string) {
  const same = await CustomerModel.findOne({ shopId: t.shopId, phone: input.phone }).select('name').lean();
  if (same) throw AppError.conflict(`${input.phone} is already ${same.name}`, { reason: 'PHONE_TAKEN', id: String(same._id), name: same.name });
  try {
    const c = await CustomerModel.create({ ...input, dob: input.dob ?? null, shopId: t.shopId, nameLower: input.name.toLowerCase(), createdBy: oid(actor.id), createdByName: actor.name });
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'customers', entityId: String(c._id), entityName: c.name, text: `${actor.name} added customer ${c.name}${input.creditLimit ? ` · udhaar limit ${inr(input.creditLimit)}` : ''}`, ip });
    return shape(await load(t, String(c._id)));
  } catch (err) {
    if (isDuplicate(err)) throw AppError.conflict(`${input.phone} is already a customer`, { reason: 'PHONE_TAKEN' });
    throw err;
  }
}

export async function get(t: TenantContext, id: string) {
  return shape(await load(t, id));
}

export async function update(t: TenantContext, actor: Actor, id: string, input: UpdateCustomerInput, ip?: string) {
  const c = await load(t, id);
  if (input.phone !== c.phone && (await CustomerModel.exists({ shopId: t.shopId, phone: input.phone }))) throw AppError.validation('Another customer has this phone', [{ field: 'body.phone', message: 'Another customer has this phone' }]);
  const { version, ...data } = input;
  const out = await CustomerModel.findOneAndUpdate({ shopId: t.shopId, _id: c._id, version }, { $set: { ...data, dob: data.dob ?? null, nameLower: data.name.toLowerCase() }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
  if (!out) throw AppError.conflict('Someone changed this customer meanwhile — reload and try again');
  const what = [c.creditLimit !== out.creditLimit ? `udhaar limit ${inr(c.creditLimit)} → ${inr(out.creditLimit)}` : '', c.status !== out.status ? out.status : ''].filter(Boolean).join(' · ');
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'customers', entityId: id, entityName: out.name, text: `${actor.name} updated ${out.name}${what ? ` · ${what}` : ''}`, ip });
  return shape(out);
}

export interface CreditRow {
  at: Date;
  kind: 'Bill' | 'Paid' | 'Return' | 'Cancelled';
  ref: string;
  saleId: string | null;
  debit: number;
  credit: number;
  balance: number;
}

/** Udhaar statement: credit bills (debit), collections, returns set off and cancelled bills (credit); ends at creditBalance. */
export async function ledger(t: TenantContext, id: string) {
  const c = await load(t, id);
  const [bills, payments, returns] = await Promise.all([
    SaleModel.find({ shopId: t.shopId, customerId: c._id, 'payments.mode': 'CREDIT' }).select('billNumber billDate payments status cancelledAt cancelledDue').lean(),
    CustomerPaymentModel.find({ shopId: t.shopId, customerId: c._id }).select('receiptNumber paymentDate amount paymentMode').lean(),
    SaleReturnModel.find({ shopId: t.shopId, customerId: c._id, adjusted: { $gt: 0 } }).select('returnNumber returnDate adjusted saleId').lean(),
  ]);
  const rows: Omit<CreditRow, 'balance'>[] = [];
  for (const s of bills) {
    const credit = s.payments.filter((p) => p.mode === 'CREDIT').reduce((a, p) => a + p.amount, 0);
    rows.push({ at: s.billDate, kind: 'Bill', ref: s.billNumber, saleId: String(s._id), debit: credit, credit: 0 });
    if (s.status === 'cancelled' && s.cancelledAt && s.cancelledDue) rows.push({ at: s.cancelledAt, kind: 'Cancelled', ref: s.billNumber, saleId: String(s._id), debit: 0, credit: s.cancelledDue });
  }
  for (const p of payments) rows.push({ at: p.paymentDate, kind: 'Paid', ref: `${p.receiptNumber} · ${p.paymentMode}`, saleId: null, debit: 0, credit: p.amount });
  for (const r of returns) rows.push({ at: r.returnDate, kind: 'Return', ref: r.returnNumber, saleId: String(r.saleId), debit: 0, credit: r.adjusted });
  rows.sort((a, b) => a.at.getTime() - b.at.getTime());
  let balance = 0;
  const out: CreditRow[] = rows.map((r) => {
    balance += r.debit - r.credit;
    return { ...r, balance };
  });
  return { rows: out, balance: c.creditBalance, limit: c.creditLimit };
}

/** Collect udhaar (PLAN §22): oldest open credit bill first; never more than is owed. */
export async function collect(t: TenantContext, actor: Actor, id: string, input: CollectInput, ip?: string) {
  return once(t.shopId, 'customer-payment', input.clientRequestId, async (session) => {
    const now = new Date();
    const c = await load(t, id, session);
    if (input.amount > c.creditBalance) throw AppError.validation(`${c.name} owes ${inr(c.creditBalance)} — that is the most you can collect`, [{ field: 'body.amount', message: `At most ${inr(c.creditBalance)}` }]);
    const open = await SaleModel.find({ shopId: t.shopId, customerId: c._id, dueAmount: { $gt: 0 }, status: { $ne: 'cancelled' } }).sort({ billDate: 1, _id: 1 }).select('billNumber dueAmount').session(session).lean();
    let left = input.amount;
    const applied: { saleId: Types.ObjectId; billNumber: string; amount: number }[] = [];
    for (const s of open) {
      if (left <= 0) break;
      const take = Math.min(left, s.dueAmount);
      const done = await SaleModel.updateOne(
        { shopId: t.shopId, _id: s._id, dueAmount: s.dueAmount },
        // The filter pins dueAmount, so the new value is known here.
        { $inc: { dueAmount: -take, paidAmount: take }, $set: { paymentStatus: s.dueAmount - take ? 'partial' : 'paid' } },
        { session },
      );
      if (!done.modifiedCount) throw AppError.conflict('A bill changed meanwhile — reload and collect again');
      applied.push({ saleId: s._id, billNumber: s.billNumber, amount: take });
      left -= take;
    }
    const moved = await CustomerModel.updateOne({ shopId: t.shopId, _id: c._id, creditBalance: { $gte: input.amount } }, { $inc: { creditBalance: -input.amount } }, { session });
    if (!moved.modifiedCount) throw AppError.conflict(`${c.name}'s udhaar changed meanwhile — reload`);
    const receiptNumber = await nextNumber(t.shopId, 'receipt', now, session);
    const [p] = await CustomerPaymentModel.create(
      [
        {
          shopId: t.shopId,
          fy: fyOf(now),
          clientRequestId: input.clientRequestId,
          receiptNumber,
          customerId: c._id,
          customerName: c.name,
          amount: input.amount,
          applied,
          paymentMode: input.mode,
          reference: input.reference,
          paymentDate: now,
          balanceBefore: c.creditBalance,
          balanceAfter: c.creditBalance - input.amount,
          createdBy: oid(actor.id),
          createdByName: actor.name,
        },
      ],
      { session },
    );
    if (!p) throw AppError.internal();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'customers', entityId: String(c._id), entityName: receiptNumber, text: `${actor.name} collected ${inr(input.amount)} udhaar from ${c.name} (${input.mode}) · ${applied.map((a) => a.billNumber).join(', ')}`, ip }, session);
    return { id: String(p._id), receiptNumber, amount: input.amount, balanceAfter: c.creditBalance - input.amount, applied: applied.map((a) => ({ billNumber: a.billNumber, amount: a.amount })) };
  });
}

/** A bill's customer: active, and room for the udhaar it adds (sandbox: no limit = no udhaar). */
export async function forBill(t: TenantContext, id: string, credit: number, session: ClientSession) {
  const c = await findCustomer(t, id, session);
  if (!c) throw AppError.validation('Customer not found', [{ field: 'body.customerId', message: 'Customer not found' }]);
  if (c.status === 'blocked') throw AppError.conflict(`${c.name} is blocked — ask the Owner or Manager`);
  if (credit) {
    if (!c.creditLimit) throw AppError.validation(`No udhaar limit is set for ${c.name}`, [{ field: 'body.payments', message: 'Set an udhaar limit on the customer first' }]);
    if (c.creditBalance + credit > c.creditLimit) {
      throw AppError.conflict(`Over ${c.name}'s udhaar limit by ${inr(c.creditBalance + credit - c.creditLimit)} — collect part now or use split`, { reason: 'OVER_LIMIT', balance: c.creditBalance, limit: c.creditLimit });
    }
  }
  return c;
}

/** Totals and udhaar after a bill, in its transaction; the limit is checked again so two counters can't both use it. */
export async function afterBill(t: TenantContext, c: CustomerLean, s: { total: number; credit: number; at: Date }, session: ClientSession) {
  const guard = s.credit ? { creditBalance: { $lte: c.creditLimit - s.credit } } : {};
  const done = await CustomerModel.updateOne({ shopId: t.shopId, _id: c._id, ...guard }, { $inc: { totalSpend: s.total, visitCount: 1, creditBalance: s.credit }, $set: { lastVisit: s.at } }, { session });
  if (!done.modifiedCount) throw AppError.conflict(`${c.name}'s udhaar changed meanwhile — over the limit now`, { reason: 'OVER_LIMIT' });
  await CustomerModel.updateOne({ shopId: t.shopId, _id: c._id, firstVisit: null }, { $set: { firstVisit: s.at } }, { session });
}

/** Undo a bill's share on the customer: cancel (whole bill) or return (part). */
export async function takeBack(t: TenantContext, customerId: Types.ObjectId, s: { spend: number; credit: number; visit: boolean }, session: ClientSession) {
  await CustomerModel.updateOne({ shopId: t.shopId, _id: customerId }, { $inc: { totalSpend: -s.spend, creditBalance: -s.credit, visitCount: s.visit ? -1 : 0 } }, { session });
}

export async function doctors(t: TenantContext, q?: string) {
  const filter: Record<string, unknown> = { shopId: t.shopId, isActive: true };
  if (q) filter.nameLower = { $regex: escape(q.toLowerCase()) };
  const rows = await DoctorModel.find(filter).sort({ nameLower: 1 }).limit(200).lean();
  return rows.map((d) => ({ id: String(d._id), name: d.name, specialization: d.specialization, registrationNumber: d.registrationNumber, phone: d.phone, clinic: d.clinic }));
}

export async function addDoctor(t: TenantContext, actor: Actor, input: DoctorInput, ip?: string) {
  const nameLower = input.name.toLowerCase();
  if (await DoctorModel.exists({ shopId: t.shopId, nameLower })) throw AppError.validation('This doctor is already in the list', [{ field: 'body.name', message: 'Already in the list' }]);
  const d = await DoctorModel.create({ ...input, shopId: t.shopId, nameLower, createdBy: oid(actor.id) });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'customers', entityId: String(d._id), entityName: d.name, text: `${actor.name} added doctor ${d.name}`, ip });
  return { id: String(d._id), name: d.name, specialization: d.specialization, registrationNumber: d.registrationNumber, phone: d.phone, clinic: d.clinic };
}

/** The doctor on an H1 bill: from the shop's list. */
export async function doctorFor(t: TenantContext, id: string, session: ClientSession) {
  const d = await DoctorModel.findOne({ shopId: t.shopId, _id: oid(id), isActive: true }).session(session).lean();
  if (!d) throw AppError.validation('Doctor not found', [{ field: 'body.rx.doctorId', message: 'Doctor not found' }]);
  return d;
}
