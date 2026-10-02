import { Types } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inr } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { photoUrl } from '../products/photo';
import { ProductModel } from '../products/product.model';
import { PurchaseModel, PurchaseReturnModel, SupplierPaymentModel } from '../purchases/purchase.model';
import { recordPayment } from '../purchases/purchases.service';
import type { Actor } from '../user/actor';
import { SupplierModel, type Supplier } from './supplier.model';
import type { PaymentInput, SupplierInput, SupplierListQuery } from './suppliers.validation';

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;
const oid = (id: string) => new Types.ObjectId(id);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 00:00 IST of the day `at` falls on. */
export const istDayStart = (at: Date) => new Date(Math.floor((at.getTime() + IST) / DAY) * DAY - IST);

/** 1 April 00:00 IST of the financial year `at` falls in. */
export function fyStart(at: Date) {
  const ist = new Date(at.getTime() + IST);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return new Date(Date.UTC(y, 3, 1) - IST);
}

/** Capitals of the name, like the sandbox: Sharma Distributors → SD. */
const codeOf = (name: string) => name.replace(/[^A-Z]/g, '').slice(0, 4) || name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'SUP';

async function load(t: TenantContext, id: string) {
  const s = await SupplierModel.findOne({ shopId: t.shopId, _id: oid(id) }).lean();
  if (!s) throw AppError.notFound('Supplier not found');
  return s;
}

const shape = (s: Supplier & { _id: Types.ObjectId }) => ({
  id: String(s._id),
  name: s.name,
  code: s.code,
  contactPerson: s.contactPerson,
  phone: s.phone,
  email: s.email,
  address: s.address,
  gstin: s.gstin,
  drugLicense: s.drugLicense,
  creditDays: s.creditDays,
  payableBalance: s.payableBalance,
  advance: s.advance,
  totalPurchases: s.totalPurchases,
  lastPurchaseAt: s.lastPurchaseAt ?? null,
  isActive: s.isActive,
  notes: s.notes,
});

export async function list(t: TenantContext, q: SupplierListQuery) {
  const filter: Record<string, unknown> = { shopId: t.shopId };
  if (q.q) {
    const re = { $regex: escape(q.q.toLowerCase()) };
    const digits = q.q.replace(/\D/g, '');
    filter.$or = [{ nameLower: re }, { gstin: { $regex: escape(q.q.toUpperCase()) } }, ...(digits.length >= 3 ? [{ phone: { $regex: escape(digits) } }] : [])];
  }
  const sort = { field: 'payableBalance', dir: -1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await SupplierModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter)
    .sort({ payableBalance: -1, _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const { items, meta } = page(rows, q.limit, (r) => r.payableBalance);
  const oldest = await PurchaseModel.aggregate<{ _id: Types.ObjectId; invoiceDate: Date; dueDate: Date }>([
    { $match: { shopId: t.shopId, supplierId: { $in: items.map((s) => s._id) }, status: 'active', dueAmount: { $gt: 0 } } },
    { $sort: { invoiceDate: 1 } },
    { $group: { _id: '$supplierId', invoiceDate: { $first: '$invoiceDate' }, dueDate: { $first: '$dueDate' } } },
  ]);
  const today = istDayStart(new Date());
  const byId = new Map(oldest.map((o) => [String(o._id), o]));
  return {
    items: items.map((s) => {
      const o = byId.get(String(s._id));
      return { ...shape(s), oldestUnpaid: o ? { invoiceDate: o.invoiceDate, dueDate: o.dueDate, overdue: o.dueDate < today } : null };
    }),
    meta,
  };
}

/** Suppliers · Total due · Due this week (overdue included) · Overdue — sandbox analytics.supplierDue. */
export async function summary(t: TenantContext) {
  const today = istDayStart(new Date());
  const week = new Date(today.getTime() + 8 * DAY - 1);
  const [s] = await SupplierModel.aggregate<{ count: number; due: number; owing: number }>([
    { $match: { shopId: t.shopId } },
    { $group: { _id: null, count: { $sum: 1 }, due: { $sum: { $max: ['$payableBalance', 0] } }, owing: { $sum: { $cond: [{ $gt: ['$payableBalance', 0] }, 1, 0] } } } },
  ]);
  const [d] = await PurchaseModel.aggregate<{ overdue: number; week: number }>([
    { $match: { shopId: t.shopId, status: 'active', dueAmount: { $gt: 0 } } },
    {
      $group: {
        _id: null,
        overdue: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, '$dueAmount', 0] } },
        week: { $sum: { $cond: [{ $lte: ['$dueDate', week] }, '$dueAmount', 0] } },
      },
    },
  ]);
  return { suppliers: s?.count ?? 0, totalDue: s?.due ?? 0, withBalance: s?.owing ?? 0, dueThisWeek: d?.week ?? 0, overdue: d?.overdue ?? 0 };
}

export async function get(t: TenantContext, id: string) {
  const s = await load(t, id);
  const fy = fyStart(new Date());
  const [inv] = await PurchaseModel.aggregate<{ fy: number; all: number; count: number }>([
    { $match: { shopId: t.shopId, supplierId: s._id, status: 'active' } },
    { $group: { _id: null, all: { $sum: '$grandTotal' }, fy: { $sum: { $cond: [{ $gte: ['$invoiceDate', fy] }, '$grandTotal', 0] } }, count: { $sum: 1 } } },
  ]);
  const [paid] = await SupplierPaymentModel.aggregate<{ total: number }>([{ $match: { shopId: t.shopId, supplierId: s._id } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
  const [ret] = await PurchaseReturnModel.aggregate<{ total: number; count: number }>([{ $match: { shopId: t.shopId, supplierId: s._id } }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]);
  const [lag] = await PurchaseModel.aggregate<{ days: number; count: number }>([
    { $match: { shopId: t.shopId, supplierId: s._id, status: 'active', paymentStatus: 'paid', paidAt: { $type: 'date' } } },
    { $group: { _id: null, days: { $avg: { $divide: [{ $subtract: ['$paidAt', '$invoiceDate'] }, DAY] } }, count: { $sum: 1 } } },
  ]);
  return {
    ...shape(s),
    tiles: {
      invoices: inv?.all ?? 0,
      invoiceCount: inv?.count ?? 0,
      payments: paid?.total ?? 0,
      returns: ret?.total ?? 0,
      returnCount: ret?.count ?? 0,
      purchasesThisFy: inv?.fy ?? 0,
      avgPaymentDays: lag ? Math.round(lag.days) : null,
      paidInvoices: lag?.count ?? 0,
    },
  };
}

export async function create(t: TenantContext, actor: Actor, input: SupplierInput, ip?: string) {
  const nameLower = input.name.toLowerCase();
  if (await SupplierModel.exists({ shopId: t.shopId, nameLower })) throw AppError.validation('A supplier with this name already exists', [{ field: 'body.name', message: 'A supplier with this name already exists' }]);
  const s = await SupplierModel.create({ shopId: t.shopId, ...input, nameLower, code: codeOf(input.name), createdBy: oid(actor.id), createdByName: actor.name });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'suppliers', entityId: String(s._id), entityName: s.name, text: `${actor.name} added supplier ${s.name}`, ip });
  return shape(s.toObject());
}

export async function update(t: TenantContext, actor: Actor, id: string, input: SupplierInput, ip?: string) {
  const s = await load(t, id);
  const nameLower = input.name.toLowerCase();
  if (nameLower !== s.nameLower && (await SupplierModel.exists({ shopId: t.shopId, nameLower }))) {
    throw AppError.validation('A supplier with this name already exists', [{ field: 'body.name', message: 'A supplier with this name already exists' }]);
  }
  const out = await SupplierModel.findOneAndUpdate({ shopId: t.shopId, _id: s._id }, { $set: { ...input, nameLower } }, { returnDocument: 'after' }).lean();
  if (!out) throw AppError.notFound('Supplier not found');
  if (out.name !== s.name) {
    await PurchaseModel.updateMany({ shopId: t.shopId, supplierId: s._id }, { $set: { supplierName: out.name } });
  }
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'suppliers', entityId: id, entityName: out.name, text: `${actor.name} updated supplier ${out.name}`, ip });
  return shape(out);
}

export interface LedgerRow {
  at: Date;
  kind: 'Invoice' | 'Cancelled' | 'Payment' | 'Return';
  ref: string;
  debit: number;
  credit: number;
  balance: number;
  link: string | null;
}

const ORDER = { Invoice: 0, Return: 1, Payment: 2, Cancelled: 3 } as const;

/** Debit = invoice, credit = payment / return / cancellation; the running balance must end at payableBalance. */
export async function ledger(t: TenantContext, id: string, from?: Date, to?: Date) {
  const s = await load(t, id);
  const [purchases, payments, returns] = await Promise.all([
    PurchaseModel.find({ shopId: t.shopId, supplierId: s._id }).select('purchaseNumber invoiceNumber invoiceDate grandTotal status cancelledAt cancelReason createdAt').lean(),
    SupplierPaymentModel.find({ shopId: t.shopId, supplierId: s._id }).select('paymentNumber paymentMode referenceNumber paymentDate amount createdAt').lean(),
    PurchaseReturnModel.find({ shopId: t.shopId, supplierId: s._id }).select('returnNumber creditNoteNumber returnDate total createdAt').lean(),
  ]);
  const rows: (Omit<LedgerRow, 'balance'> & { seq: Date })[] = [];
  for (const p of purchases) {
    rows.push({ at: p.invoiceDate, seq: p.createdAt, kind: 'Invoice', ref: `${p.invoiceNumber} · ${p.purchaseNumber}`, debit: p.grandTotal, credit: 0, link: `/purchases/${String(p._id)}` });
    if (p.status === 'cancelled' && p.cancelledAt) rows.push({ at: p.cancelledAt, seq: p.cancelledAt, kind: 'Cancelled', ref: `${p.purchaseNumber} · ${p.cancelReason ?? ''}`, debit: 0, credit: p.grandTotal, link: `/purchases/${String(p._id)}` });
  }
  for (const x of payments) rows.push({ at: x.paymentDate, seq: x.createdAt, kind: 'Payment', ref: [x.paymentNumber, x.paymentMode, x.referenceNumber].filter(Boolean).join(' · '), debit: 0, credit: x.amount, link: null });
  for (const r of returns) rows.push({ at: r.returnDate, seq: r.createdAt, kind: 'Return', ref: [r.returnNumber, r.creditNoteNumber].filter(Boolean).join(' · '), debit: 0, credit: r.total, link: null });
  rows.sort((a, b) => a.at.getTime() - b.at.getTime() || a.seq.getTime() - b.seq.getTime() || ORDER[a.kind] - ORDER[b.kind]);

  const start = from ?? fyStart(new Date());
  const end = to ? new Date(to.getTime() + DAY - 1) : null;
  let balance = 0;
  let opening = 0;
  const out: LedgerRow[] = [];
  for (const r of rows) {
    balance += r.debit - r.credit;
    if (r.at < start) opening = balance;
    else if (!end || r.at <= end) out.push({ at: r.at, kind: r.kind, ref: r.ref, debit: r.debit, credit: r.credit, link: r.link, balance });
  }
  return {
    supplier: { id: String(s._id), name: s.name, payableBalance: s.payableBalance },
    from: start,
    to: end,
    opening,
    rows: out,
    closing: out.at(-1)?.balance ?? opening,
    total: balance,
  };
}

/** Every medicine this supplier has sent, newest first (S35 Products supplied, purchase entry "bought before"). */
export async function productsOf(t: TenantContext, id: string, limit = 200) {
  const s = await load(t, id);
  const rows = await PurchaseModel.aggregate<{ _id: Types.ObjectId; last: Date; times: number }>([
    { $match: { shopId: t.shopId, supplierId: s._id, status: 'active' } },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.productId', last: { $max: '$invoiceDate' }, times: { $sum: 1 } } },
    { $sort: { last: -1, _id: 1 } },
    { $limit: limit },
  ]);
  const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: rows.map((r) => r._id) } }).select('name company photo isActive').lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return rows.flatMap((r) => {
    const p = byId.get(String(r._id));
    return p ? [{ id: String(p._id), name: p.name, company: p.company, photo: photoUrl(p.photo), isActive: p.isActive, lastPurchasedAt: r.last, times: r.times }] : [];
  });
}

/** Last 90 days of invoices by supplier — how much the shop depends on each one (S34, PLAN chart #12). */
export async function chart(t: TenantContext) {
  const from = new Date(istDayStart(new Date()).getTime() - 89 * DAY);
  const rows = await PurchaseModel.aggregate<{ _id: Types.ObjectId; name: string; total: number; count: number }>([
    { $match: { shopId: t.shopId, status: 'active', invoiceDate: { $gte: from } } },
    { $group: { _id: '$supplierId', name: { $last: '$supplierName' }, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
    { $sort: { total: -1, _id: 1 } },
    { $limit: 12 },
  ]);
  return { from, rows: rows.map((r) => ({ id: String(r._id), name: r.name, total: r.total, invoices: r.count })) };
}

export async function pay(t: TenantContext, actor: Actor, id: string, input: PaymentInput, ip?: string) {
  return once(t.shopId, 'supplier-payment', input.clientRequestId, async (session) => {
    const s = await SupplierModel.findOne({ shopId: t.shopId, _id: oid(id) }).session(session).lean();
    if (!s) throw AppError.notFound('Supplier not found');
    const out = await recordPayment(t, actor, s, input, new Date(), session);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'suppliers', entityId: id, entityName: s.name, text: `${actor.name} recorded ${inr(input.amount)} paid to ${s.name} · ${input.mode}${out.advanceAdded ? ` · ${inr(out.advanceAdded)} kept as advance` : ''}`, ip },
      session,
    );
    return out;
  });
}

/** Every invoice with money still due, oldest first — the order a payment is spread in. */
export async function openInvoices(t: TenantContext, id: string) {
  const s = await load(t, id);
  const rows = await PurchaseModel.find({ shopId: t.shopId, supplierId: s._id, status: 'active', dueAmount: { $gt: 0 } })
    .sort({ invoiceDate: 1, _id: 1 })
    .select('purchaseNumber invoiceNumber invoiceDate dueDate grandTotal dueAmount')
    .lean();
  return rows.map((p) => ({ id: String(p._id), purchaseNumber: p.purchaseNumber, invoiceNumber: p.invoiceNumber, invoiceDate: p.invoiceDate, dueDate: p.dueDate, grandTotal: p.grandTotal, dueAmount: p.dueAmount }));
}
