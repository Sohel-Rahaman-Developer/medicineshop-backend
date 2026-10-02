import { Types } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { fyOf } from '../../utils/fy';
import { gstExclusive, inr } from '../../utils/money';
import { fromBase, salePack, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { nextNumber } from '../counters/counter.model';
import { ProductModel } from '../products/product.model';
import { BatchModel } from '../stock/batch.model';
import { bucketOf, daysLeftOut } from '../stock/stock.domain';
import { applyMove, refreshRollups } from '../stock/stock.ledger';
import { credit } from '../suppliers/supplier.ledger';
import { SupplierModel } from '../suppliers/supplier.model';
import type { Actor } from '../user/actor';
import { PurchaseModel, PurchaseReturnModel } from './purchase.model';
import type { ReturnInput, ReturnListQuery } from './purchases.validation';

const oid = (id: string) => new Types.ObjectId(id);
const REASON: Record<string, string> = { EXPIRY: 'expiry', NEAR_EXPIRY: 'near expiry', DAMAGED: 'damaged', WRONG_ITEM: 'wrong item' };

/** A supplier's batches still on the shelf, the ones expiring first on top (sandbox S33). */
export async function candidates(t: TenantContext, supplierId: string, purchaseId?: string) {
  const now = new Date();
  const filter: Record<string, unknown> = { shopId: t.shopId, supplierId: oid(supplierId), status: { $ne: 'returned' }, quantity: { $gt: 0 } };
  if (purchaseId) filter.purchaseId = oid(purchaseId);
  const rows = await BatchModel.find(filter).sort({ expiryDate: 1, _id: 1 }).limit(300).lean();
  const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: [...new Set(rows.map((b) => String(b.productId)))].map(oid) } }).select('name units gstRate storageType').lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return rows.map((b) => {
    const p = byId.get(String(b.productId));
    const u = p?.units as Units | undefined;
    return {
      id: String(b._id),
      productId: String(b.productId),
      productName: p?.name ?? '',
      units: u ? { base: u.base, sale: u.sale, salePack: salePack(u) } : { base: '', sale: '', salePack: 1 },
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      daysLeft: daysLeftOut(b.expiryDate, now),
      bucket: bucketOf(b, now),
      quantity: b.quantity,
      rack: b.rack,
      costPerBaseUnit: b.costPerBaseUnit,
      gstRate: p?.gstRate ?? 0,
      purchaseId: b.purchaseId ? String(b.purchaseId) : null,
      invoiceNumber: b.purchaseInvoiceNumber ?? null,
    };
  });
}

export async function create(t: TenantContext, actor: Actor, input: ReturnInput, ip?: string) {
  return once(t.shopId, 'purchase-return', input.clientRequestId, async (session) => {
    const now = new Date();
    const sup = await SupplierModel.findOne({ shopId: t.shopId, _id: oid(input.supplierId) }).session(session).lean();
    if (!sup) throw AppError.notFound('Supplier not found');
    const pur = input.purchaseId ? await PurchaseModel.findOne({ shopId: t.shopId, _id: oid(input.purchaseId) }).select('purchaseNumber supplierId status').session(session).lean() : null;
    if (input.purchaseId && !pur) throw AppError.notFound('Purchase not found');
    if (pur && String(pur.supplierId) !== String(sup._id)) throw AppError.validation('That purchase is from another supplier', [{ field: 'body.purchaseId', message: 'That purchase is from another supplier' }]);

    const batches = await BatchModel.find({ shopId: t.shopId, _id: { $in: input.lines.map((l) => oid(l.batchId)) } }).session(session).lean();
    if (batches.length !== input.lines.length) throw AppError.notFound('One of the batches was not found');
    const bmap = new Map(batches.map((b) => [String(b._id), b]));
    const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: batches.map((b) => b.productId) } }).select('name units gstRate').session(session).lean();
    const pmap = new Map(products.map((p) => [String(p._id), p]));

    const id = new Types.ObjectId();
    const number = await nextNumber(t.shopId, 'purchaseReturn', now, session);
    const lines = [];
    let subtotal = 0;
    let tax = 0;
    for (const [i, l] of input.lines.entries()) {
      const b = bmap.get(l.batchId);
      const p = b && pmap.get(String(b.productId));
      if (!b || !p) throw AppError.notFound('Batch not found');
      const bad = (m: string) => AppError.validation(m, [{ field: `body.lines.${String(i)}`, message: m }]);
      if (b.status === 'returned') throw AppError.conflict(`Batch ${b.batchNumber} already went back to the supplier`);
      if (String(b.supplierId) !== String(sup._id)) throw bad(`Batch ${b.batchNumber} did not come from ${sup.name}`);
      if (pur && String(b.purchaseId) !== String(pur._id)) throw bad(`Batch ${b.batchNumber} is not on ${pur.purchaseNumber}`);
      if (l.quantity > b.quantity) throw AppError.conflict(`Only ${fromBase(b.quantity, p.units as Units)} of ${b.batchNumber} is left`);
      const moved = await applyMove(t.shopId, b._id, -l.quantity, { type: 'PURCHASE_RETURN', refType: 'PURCHASE_RETURN', refId: id, refNumber: number, reason: REASON[input.reason], actor, at: now }, session);
      if (moved.after === 0) await BatchModel.updateOne({ shopId: t.shopId, _id: b._id }, { $set: { status: 'returned' } }, { session });
      const amount = l.quantity * b.costPerBaseUnit;
      const g = gstExclusive(amount, p.gstRate);
      subtotal += amount;
      tax += g.tax;
      lines.push({ productId: p._id, productName: p.name, batchId: b._id, batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: l.quantity, costPerBaseUnit: b.costPerBaseUnit, gstRate: p.gstRate, amount, tax: g.tax });
    }
    const total = subtotal + tax;
    const { applied, advanceAdded } = await credit(t.shopId, sup._id, total, { kind: 'return', refId: id, refNumber: number, at: now }, session, pur?._id);
    await PurchaseReturnModel.create(
      [
        {
          _id: id,
          shopId: t.shopId,
          fy: fyOf(now),
          clientRequestId: input.clientRequestId,
          returnNumber: number,
          purchaseId: pur?._id,
          purchaseNumber: pur?.purchaseNumber,
          supplierId: sup._id,
          supplierName: sup.name,
          returnDate: now,
          reason: input.reason,
          lines,
          subtotal,
          tax,
          total,
          applied,
          advanceAdded,
          notes: input.notes,
          createdBy: oid(actor.id),
          createdByName: actor.name,
        },
      ],
      { session },
    );
    await refreshRollups(t.shopId, [...new Set(lines.map((l) => String(l.productId)))].map(oid), session, now);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'purchases', entityId: String(id), entityName: number, text: `${actor.name} returned ${String(lines.length)} ${lines.length === 1 ? 'batch' : 'batches'} to ${sup.name} · ${inr(total)} · ${REASON[input.reason] ?? ''}`, ip },
      session,
    );
    return { id: String(id), returnNumber: number, total, advanceAdded };
  });
}

type ReturnDoc = {
  _id: Types.ObjectId;
  returnNumber: string;
  supplierId: Types.ObjectId;
  supplierName: string;
  purchaseId?: Types.ObjectId | null;
  purchaseNumber?: string | null;
  reason: string;
  returnDate: Date;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  creditNoteNumber?: string | null;
  lines: unknown[];
};

const brief = (r: ReturnDoc) => ({
  id: String(r._id),
  returnNumber: r.returnNumber,
  supplierId: String(r.supplierId),
  supplierName: r.supplierName,
  purchaseId: r.purchaseId ? String(r.purchaseId) : null,
  purchaseNumber: r.purchaseNumber ?? null,
  reason: r.reason,
  returnDate: r.returnDate,
  lines: r.lines.length,
  subtotal: r.subtotal,
  tax: r.tax,
  total: r.total,
  status: r.status,
  creditNoteNumber: r.creditNoteNumber ?? null,
});

export async function list(t: TenantContext, q: ReturnListQuery) {
  const filter: Record<string, unknown> = { shopId: t.shopId };
  if (q.supplierId) filter.supplierId = oid(q.supplierId);
  if (q.status) filter.status = q.status;
  const sort = { field: 'returnDate', dir: -1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await PurchaseReturnModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter).sort({ returnDate: -1, _id: -1 }).limit(q.limit + 1).lean();
  const { items, meta } = page(rows, q.limit, (r) => r.returnDate);
  return { items: items.map(brief), meta };
}

export async function get(t: TenantContext, id: string) {
  const r = await PurchaseReturnModel.findOne({ shopId: t.shopId, _id: oid(id) }).lean();
  if (!r) throw AppError.notFound('Return not found');
  const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: r.lines.map((l) => l.productId) } }).select('units').lean();
  const units = new Map(products.map((p) => [String(p._id), p.units as Units]));
  return {
    ...brief(r),
    settledAt: r.settledAt ?? null,
    settledBy: r.settledBy ?? null,
    createdByName: r.createdByName,
    advanceAdded: r.advanceAdded,
    applied: r.applied.map((a) => ({ purchaseId: String(a.purchaseId), purchaseNumber: a.purchaseNumber ?? '', invoiceNumber: a.invoiceNumber ?? '', amount: a.amount })),
    lines: r.lines.map((l) => {
      const u = units.get(String(l.productId));
      return { productId: String(l.productId), productName: l.productName, batchId: String(l.batchId), batchNumber: l.batchNumber, expiryDate: l.expiryDate, quantity: l.quantity, qtyLabel: u ? fromBase(l.quantity, u) : String(l.quantity), costPerBaseUnit: l.costPerBaseUnit, gstRate: l.gstRate, amount: l.amount, tax: l.tax };
    }),
  };
}

/** The supplier's credit note arrived — the money was already credited when the goods went back. */
export async function settle(t: TenantContext, actor: Actor, id: string, creditNoteNumber: string, ip?: string) {
  return inTransaction(async (session) => {
    const r = await PurchaseReturnModel.findOneAndUpdate(
      { shopId: t.shopId, _id: oid(id), status: 'pending' },
      { $set: { status: 'settled', creditNoteNumber, settledAt: new Date(), settledBy: actor.name } },
      { session, returnDocument: 'after' },
    ).lean();
    if (!r) {
      const exists = await PurchaseReturnModel.exists({ shopId: t.shopId, _id: oid(id) }).session(session);
      throw exists ? AppError.conflict('This return is already settled') : AppError.notFound('Return not found');
    }
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'purchases', entityId: id, entityName: r.returnNumber, text: `${actor.name} settled ${r.returnNumber} · credit note ${creditNoteNumber}`, ip }, session);
    return { returnNumber: r.returnNumber, creditNoteNumber };
  });
}
