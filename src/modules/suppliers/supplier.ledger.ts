import type { ClientSession, Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { applyCredit, paymentStatusOf } from '../purchases/purchase.domain';
import { PurchaseModel } from '../purchases/purchase.model';
import { SupplierModel } from './supplier.model';

// The only writer of Supplier.payableBalance / advance and Purchase.paidAmount / dueAmount (D52).

type Kind = 'payment' | 'return' | 'advance';
interface Source {
  kind: Kind;
  refId?: Types.ObjectId;
  refNumber?: string;
  at: Date;
}

async function openInvoices(shopId: Types.ObjectId, supplierId: Types.ObjectId, session: ClientSession) {
  return PurchaseModel.find({ shopId, supplierId, status: 'active', dueAmount: { $gt: 0 } })
    .select('purchaseNumber invoiceNumber invoiceDate grandTotal dueAmount')
    .session(session)
    .lean();
}

/** Spreads money over open invoices (preferred one first, then oldest) and returns what each got. */
async function spread(shopId: Types.ObjectId, supplierId: Types.ObjectId, amount: number, src: Source, session: ClientSession, preferId?: Types.ObjectId) {
  const open = await openInvoices(shopId, supplierId, session);
  const { applied, left } = applyCredit(
    open.map((p) => ({ id: String(p._id), dueAmount: p.dueAmount, invoiceDate: p.invoiceDate })),
    amount,
    preferId ? String(preferId) : undefined,
  );
  const byId = new Map(open.map((p) => [String(p._id), p]));
  const out = [];
  for (const a of applied) {
    const p = byId.get(a.id);
    if (!p) continue;
    const due = p.dueAmount - a.amount;
    const res = await PurchaseModel.updateOne(
      { shopId, _id: p._id, dueAmount: p.dueAmount },
      {
        $inc: { paidAmount: a.amount, dueAmount: -a.amount },
        $push: { allocations: { kind: src.kind, refId: src.refId, refNumber: src.refNumber, amount: a.amount, at: src.at } },
        $set: { paymentStatus: paymentStatusOf(p.grandTotal, due), ...(due === 0 ? { paidAt: src.at } : {}) },
      },
      { session },
    );
    if (res.modifiedCount !== 1) throw AppError.conflict('This supplier’s account changed just now. Try again.');
    out.push({ purchaseId: p._id, purchaseNumber: p.purchaseNumber, invoiceNumber: p.invoiceNumber, amount: a.amount });
  }
  return { applied: out, left };
}

/** A new invoice: the balance goes up, and advance already with the supplier pays it first. */
export async function chargeInvoice(shopId: Types.ObjectId, supplierId: Types.ObjectId, purchaseId: Types.ObjectId, total: number, at: Date, session: ClientSession) {
  const sup = await SupplierModel.findOneAndUpdate(
    { shopId, _id: supplierId },
    { $inc: { payableBalance: total, totalPurchases: total }, $set: { lastPurchaseAt: at } },
    { session, returnDocument: 'before' },
  ).lean();
  if (!sup) throw AppError.notFound('Supplier not found');
  const take = Math.min(sup.advance, total);
  if (take > 0) {
    const { left } = await spread(shopId, supplierId, take, { kind: 'advance', at }, session, purchaseId);
    await SupplierModel.updateOne({ shopId, _id: supplierId }, { $inc: { advance: -(take - left) } }, { session });
  }
  return take;
}

/** Payment or return credit: lowers the balance; open invoices take it, the rest becomes advance. */
export async function credit(shopId: Types.ObjectId, supplierId: Types.ObjectId, amount: number, src: Source, session: ClientSession, preferId?: Types.ObjectId) {
  const { applied, left } = await spread(shopId, supplierId, amount, src, session, preferId);
  const res = await SupplierModel.updateOne({ shopId, _id: supplierId }, { $inc: { payableBalance: -amount, advance: left } }, { session });
  if (res.matchedCount !== 1) throw AppError.notFound('Supplier not found');
  return { applied, advanceAdded: left };
}

/** A cancelled invoice leaves the account; what was paid on it turns into advance for the other invoices. */
export async function reverseInvoice(shopId: Types.ObjectId, supplierId: Types.ObjectId, total: number, paid: number, at: Date, session: ClientSession) {
  await SupplierModel.updateOne({ shopId, _id: supplierId }, { $inc: { payableBalance: -total, totalPurchases: -total, advance: paid } }, { session });
  if (paid <= 0) return;
  const { left } = await spread(shopId, supplierId, paid, { kind: 'advance', at }, session);
  await SupplierModel.updateOne({ shopId, _id: supplierId }, { $inc: { advance: -(paid - left) } }, { session });
}
