import { Types } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { fyOf } from '../../utils/fy';
import { inr } from '../../utils/money';
import { conv, salePack, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { nextNumber } from '../counters/counter.model';
import { ProductModel } from '../products/product.model';
import { BatchModel } from '../stock/batch.model';
import { applyMove, refreshRollups } from '../stock/stock.ledger';
import { mergeTarget, mrpDiffers, receiveBatch } from '../stock/stock.service';
import { chargeInvoice, credit, reverseInvoice } from '../suppliers/supplier.ledger';
import { SupplierModel } from '../suppliers/supplier.model';
import type { Actor } from '../user/actor';
import { purchaseLine, purchaseTotals } from './purchase.domain';
import { PurchaseModel, PurchaseReturnModel, SupplierPaymentModel, type PayMode } from './purchase.model';
import type { PurchaseInput, PurchaseListQuery } from './purchases.validation';

const DAY = 24 * 60 * 60 * 1000;
const oid = (id: string) => new Types.ObjectId(id);
const unitsBrief = (u: Units) => ({ base: u.base, sale: u.sale, purchase: u.purchase, salePack: salePack(u), conversions: u.conversions });
const lineError = (i: number, message: string) => AppError.validation(message, [{ field: `body.lines.${String(i)}`, message }]);

/** Everything the entry screen pre-fills for a product: last purchase, last MRP and batches the merge rule would hit. */
export async function lineInfo(t: TenantContext, productId: string) {
  const p = await ProductModel.findOne({ shopId: t.shopId, _id: oid(productId) }).select('name company units gstRate defaultRack storageType isActive').lean();
  if (!p) throw AppError.notFound('Product not found');
  const [last] = await PurchaseModel.aggregate<{ line: { rate: number; unit: string; discountPercent: number; gstRate: number; mrp: number; rack: string }; supplierName: string; invoiceDate: Date }>([
    { $match: { shopId: t.shopId, status: 'active', 'lines.productId': p._id } },
    { $sort: { invoiceDate: -1, createdAt: -1 } },
    { $limit: 1 },
    { $project: { supplierName: 1, invoiceDate: 1, line: { $first: { $filter: { input: '$lines', cond: { $eq: ['$$this.productId', p._id] } } } } } },
  ]);
  const batches = await BatchModel.find({ shopId: t.shopId, productId: p._id, status: { $ne: 'returned' } })
    .sort({ receivedAt: -1, _id: -1 })
    .select('batchNumber expiryDate mrp quantity receivedAt')
    .limit(60)
    .lean();
  const latest = await BatchModel.findOne({ shopId: t.shopId, productId: p._id }).sort({ receivedAt: -1, _id: -1 }).select('mrp').lean();
  return {
    product: { id: String(p._id), name: p.name, company: p.company, units: unitsBrief(p.units as Units), gstRate: p.gstRate, defaultRack: p.defaultRack, storageType: p.storageType, isActive: p.isActive },
    last: last
      ? { rate: last.line.rate, unit: last.line.unit, discountPercent: last.line.discountPercent, gstRate: last.line.gstRate, mrp: last.line.mrp, rack: last.line.rack, supplierName: last.supplierName, invoiceDate: last.invoiceDate }
      : null,
    lastMrp: latest?.mrp ?? null,
    batches: batches.map((b) => ({ id: String(b._id), batchNumber: b.batchNumber, expiryDate: b.expiryDate, mrp: b.mrp, quantity: b.quantity })),
  };
}

export async function create(t: TenantContext, actor: Actor, input: PurchaseInput, ip?: string) {
  return once(t.shopId, 'purchase', input.clientRequestId, async (session) => {
    const now = new Date();
    const sup = await SupplierModel.findOne({ shopId: t.shopId, _id: oid(input.supplierId) }).session(session).lean();
    if (!sup) throw AppError.notFound('Supplier not found');
    if (!sup.isActive) throw AppError.conflict(`${sup.name} is deactivated. Reactivate the supplier first.`);
    const invoiceLower = input.invoiceNumber.toLowerCase();
    if (await PurchaseModel.exists({ shopId: t.shopId, supplierId: sup._id, invoiceNumberLower: invoiceLower, status: 'active' }).session(session)) {
      throw AppError.conflict(`Invoice ${input.invoiceNumber} from ${sup.name} is already entered.`, { reason: 'DUPLICATE_INVOICE' });
    }

    const ids = [...new Set(input.lines.map((l) => l.productId))].map(oid);
    const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: ids } }).session(session).lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const seen = new Set<string>();
    const lastMrp = new Map<string, number>();
    const conflicts = [];
    for (const [i, l] of input.lines.entries()) {
      const p = byId.get(l.productId);
      if (!p) throw lineError(i, `Line ${String(i + 1)}: product not found`);
      if (!p.isActive) throw lineError(i, `Line ${String(i + 1)}: ${p.name} is deactivated`);
      const u = p.units as Units;
      if (l.unit !== u.sale && l.unit !== u.purchase) throw lineError(i, `Line ${String(i + 1)}: buy ${p.name} in ${u.purchase} or ${u.sale}`);
      if (l.expiry.getTime() < now.getTime()) throw lineError(i, `Line ${String(i + 1)}: batch ${l.batchNumber} has already expired — don’t take it into stock`);
      const key = `${l.productId}|${l.batchNumber.toUpperCase()}|${String(l.expiry.getTime())}`;
      if (seen.has(key)) throw lineError(i, `Line ${String(i + 1)}: ${p.name} batch ${l.batchNumber} is listed twice — put it on one line`);
      seen.add(key);
      if (!lastMrp.has(l.productId)) {
        const latest = await BatchModel.findOne({ shopId: t.shopId, productId: p._id }).sort({ receivedAt: -1, _id: -1 }).select('mrp').session(session).lean();
        if (latest) lastMrp.set(l.productId, latest.mrp);
      }
      const same = l.mrpChoice ? null : await mergeTarget(t.shopId, p._id, l.batchNumber, l.expiry, session);
      if (same && same.mrp !== l.mrp) conflicts.push({ index: i, productName: p.name, batch: { id: String(same._id), batchNumber: same.batchNumber, mrp: same.mrp }, mrp: l.mrp });
    }
    const first = conflicts[0];
    if (first) {
      const b = { _id: oid(first.batch.id), batchNumber: first.batch.batchNumber, expiryDate: input.lines[first.index]?.expiry ?? now, mrp: first.batch.mrp };
      throw mrpDiffers(b, first.mrp, { lines: conflicts });
    }

    const purchaseId = new Types.ObjectId();
    const number = await nextNumber(t.shopId, 'purchase', now, session);
    const lines = [];
    const mrpChanges = [];
    for (const l of input.lines) {
      const p = byId.get(l.productId);
      if (!p) throw AppError.internal();
      const u = p.units as Units;
      const c = conv(u, l.unit);
      const calc = purchaseLine({ quantity: l.quantity, freeQuantity: l.freeQuantity, rate: l.rate, discountPercent: l.discountPercent, gstRate: l.gstRate, conv: c });
      const got = await receiveBatch(
        t.shopId,
        p,
        { batchNumber: l.batchNumber, expiry: l.expiry, mfg: l.mfg, mrp: l.mrp, rack: l.rack, mrpChoice: l.mrpChoice },
        { source: 'purchase', quantity: calc.baseQty, freeQuantity: calc.freeBase, purchaseRate: l.rate, purchaseUnit: l.unit, costPerBaseUnit: calc.costPerBaseUnit, supplierId: sup._id, purchaseId, invoiceNumber: input.invoiceNumber, refNumber: number },
        actor,
        session,
        now,
      );
      const before = got.how === 'merged' ? got.mrpBefore : (lastMrp.get(l.productId) ?? null);
      if (before !== null && before !== l.mrp) mrpChanges.push({ productId: p._id, productName: p.name, batchNumber: got.batchNumber, from: before, to: l.mrp });
      const batch = await BatchModel.findOne({ shopId: t.shopId, _id: oid(got.batchId) }).select('rack').session(session).lean();
      lines.push({
        productId: p._id,
        productName: p.name,
        batchId: oid(got.batchId),
        batchNumber: got.batchNumber,
        expiryDate: l.expiry,
        mfgDate: l.mfg,
        quantity: l.quantity,
        freeQuantity: l.freeQuantity,
        unit: l.unit,
        conv: c,
        quantityInBase: calc.baseQty,
        freeInBase: calc.freeBase,
        rate: l.rate,
        discountPercent: l.discountPercent,
        grossAmount: calc.gross,
        discountAmount: calc.discount,
        taxableAmount: calc.taxable,
        gstRate: l.gstRate,
        cgst: calc.cgst,
        sgst: calc.sgst,
        igst: 0,
        totalAmount: calc.total,
        mrp: l.mrp,
        landingPerUnit: calc.landingPerUnit,
        costPerBaseUnit: calc.costPerBaseUnit,
        rack: batch?.rack ?? '',
        how: got.how,
      });
    }
    const tt = purchaseTotals(lines.map((l) => ({ gross: l.grossAmount, discount: l.discountAmount, taxable: l.taxableAmount, cgst: l.cgst, sgst: l.sgst })));
    const pay = input.payment;
    if (pay.amount > tt.grandTotal) throw AppError.validation(`Paid can’t be more than the total ${inr(tt.grandTotal)}`, [{ field: 'body.payment.amount', message: `Paid can’t be more than the total ${inr(tt.grandTotal)}` }]);

    const dupInvoice = (err: unknown): never => {
      if ((err as { code?: number }).code === 11000) throw AppError.conflict(`Invoice ${input.invoiceNumber} from ${sup.name} is already entered.`, { reason: 'DUPLICATE_INVOICE' });
      throw err;
    };
    await PurchaseModel.create(
      [
        {
          _id: purchaseId,
          shopId: t.shopId,
          fy: fyOf(input.invoiceDate),
          clientRequestId: input.clientRequestId,
          purchaseNumber: number,
          invoiceNumber: input.invoiceNumber,
          invoiceNumberLower: invoiceLower,
          supplierId: sup._id,
          supplierName: sup.name,
          invoiceDate: input.invoiceDate,
          dueDate: input.dueDate ?? new Date(input.invoiceDate.getTime() + sup.creditDays * DAY),
          receivedDate: now,
          lines,
          subtotal: tt.subtotal,
          totalDiscount: tt.discount,
          taxableAmount: tt.taxable,
          cgst: tt.cgst,
          sgst: tt.sgst,
          igst: 0,
          roundOff: tt.roundOff,
          grandTotal: tt.grandTotal,
          paidAmount: 0,
          dueAmount: tt.grandTotal,
          paymentStatus: 'unpaid',
          mrpChanges,
          notes: input.notes,
          createdBy: oid(actor.id),
          createdByName: actor.name,
        },
      ],
      { session },
    ).catch(dupInvoice);
    const fromAdvance = await chargeInvoice(t.shopId, sup._id, purchaseId, tt.grandTotal, now, session);
    let payment = null;
    if (pay.amount > 0) {
      const mode: PayMode = pay.mode === 'CREDIT' ? 'CASH' : pay.mode;
      payment = await recordPayment(t, actor, sup, { amount: pay.amount, mode, fromDrawer: mode === 'CASH' ? pay.fromDrawer : false, reference: pay.reference, notes: `With ${number}`, clientRequestId: input.clientRequestId }, now, session, purchaseId);
    }
    await refreshRollups(t.shopId, ids, session, now);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'purchases', entityId: String(purchaseId), entityName: number, text: `${actor.name} entered ${number} from ${sup.name} · ${inr(tt.grandTotal)} · ${String(lines.length)} ${lines.length === 1 ? 'line' : 'lines'}`, ip },
      session,
    );
    return { id: String(purchaseId), purchaseNumber: number, grandTotal: tt.grandTotal, lines: lines.length, fromAdvance, paymentNumber: payment?.paymentNumber ?? null };
  });
}

interface PayArgs {
  amount: number;
  mode: PayMode;
  fromDrawer: boolean;
  reference: string;
  notes: string;
  clientRequestId: string;
}

/** Writes a SupplierPayment and spreads it; the caller owns the transaction. */
export async function recordPayment(t: TenantContext, actor: Actor, sup: { _id: Types.ObjectId; name: string }, a: PayArgs, now: Date, session: import('mongoose').ClientSession, preferId?: Types.ObjectId) {
  const id = new Types.ObjectId();
  const paymentNumber = await nextNumber(t.shopId, 'supplierPayment', now, session);
  const { applied, advanceAdded } = await credit(t.shopId, sup._id, a.amount, { kind: 'payment', refId: id, refNumber: paymentNumber, at: now }, session, preferId);
  await SupplierPaymentModel.create(
    [
      {
        _id: id,
        shopId: t.shopId,
        fy: fyOf(now),
        clientRequestId: a.clientRequestId,
        paymentNumber,
        supplierId: sup._id,
        supplierName: sup.name,
        amount: a.amount,
        applied,
        advanceAdded,
        paymentMode: a.mode,
        fromDrawer: a.mode === 'CASH' ? a.fromDrawer : false,
        referenceNumber: a.reference,
        paymentDate: now,
        notes: a.notes,
        createdBy: oid(actor.id),
        createdByName: actor.name,
      },
    ],
    { session },
  );
  return { id: String(id), paymentNumber, amount: a.amount, applied: applied.map((x) => ({ ...x, purchaseId: String(x.purchaseId) })), advanceAdded };
}

function listItem(p: { _id: Types.ObjectId; purchaseNumber: string; invoiceNumber: string; invoiceDate: Date; dueDate: Date; supplierId: Types.ObjectId; supplierName: string; lines: unknown[]; grandTotal: number; paidAmount: number; dueAmount: number; paymentStatus: string; status: string }) {
  return {
    id: String(p._id),
    purchaseNumber: p.purchaseNumber,
    invoiceNumber: p.invoiceNumber,
    invoiceDate: p.invoiceDate,
    dueDate: p.dueDate,
    supplierId: String(p.supplierId),
    supplierName: p.supplierName,
    lines: p.lines.length,
    grandTotal: p.grandTotal,
    paidAmount: p.paidAmount,
    dueAmount: p.dueAmount,
    paymentStatus: p.paymentStatus,
    status: p.status,
  };
}

const dayEnd = (d: Date) => new Date(d.getTime() + DAY - 1);

export async function list(t: TenantContext, q: PurchaseListQuery) {
  const filter: Record<string, unknown> = { shopId: t.shopId };
  if (q.supplierId) filter.supplierId = oid(q.supplierId);
  if (q.paymentStatus) Object.assign(filter, { paymentStatus: q.paymentStatus, status: 'active' });
  if (q.from || q.to) filter.invoiceDate = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: dayEnd(q.to) } : {}) };
  const sort = { field: 'invoiceDate', dir: -1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await PurchaseModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter)
    .sort({ invoiceDate: -1, _id: -1 })
    .limit(q.limit + 1)
    .select('-lines.productName -allocations -mrpChanges')
    .lean();
  const { items, meta } = page(rows, q.limit, (r) => r.invoiceDate);
  return { items: items.map(listItem), meta };
}

/** Tiles for a date range: invoices, paid, due, returns (cancelled invoices count nowhere). */
export async function summary(t: TenantContext, from: Date, to: Date) {
  const end = dayEnd(to);
  const [p] = await PurchaseModel.aggregate<{ count: number; total: number; paid: number; due: number }>([
    { $match: { shopId: t.shopId, status: 'active', invoiceDate: { $gte: from, $lte: end } } },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$grandTotal' }, paid: { $sum: '$paidAmount' }, due: { $sum: '$dueAmount' } } },
  ]);
  const [r] = await PurchaseReturnModel.aggregate<{ count: number; total: number }>([
    { $match: { shopId: t.shopId, returnDate: { $gte: from, $lte: end } } },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } },
  ]);
  return { invoices: p?.count ?? 0, total: p?.total ?? 0, paid: p?.paid ?? 0, due: p?.due ?? 0, returns: r?.total ?? 0, returnCount: r?.count ?? 0 };
}

export async function get(t: TenantContext, id: string) {
  const p = await PurchaseModel.findOne({ shopId: t.shopId, _id: oid(id) }).lean();
  if (!p) throw AppError.notFound('Purchase not found');
  const [sup, products, batches] = await Promise.all([
    SupplierModel.findOne({ shopId: t.shopId, _id: p.supplierId }).select('name contactPerson phone gstin creditDays').lean(),
    ProductModel.find({ shopId: t.shopId, _id: { $in: p.lines.map((l) => l.productId) } }).select('units').lean(),
    BatchModel.find({ shopId: t.shopId, _id: { $in: p.lines.map((l) => l.batchId) } }).select('purchaseId quantity status').lean(),
  ]);
  const units = new Map(products.map((x) => [String(x._id), x.units as Units]));
  return {
    ...listItem(p),
    receivedDate: p.receivedDate,
    supplier: sup ? { id: String(sup._id), name: sup.name, contactPerson: sup.contactPerson, phone: sup.phone, gstin: sup.gstin, creditDays: sup.creditDays } : null,
    lines: p.lines.map((l) => {
      const u = units.get(String(l.productId));
      return {
        productId: String(l.productId),
        productName: l.productName,
        batchId: String(l.batchId),
        batchNumber: l.batchNumber,
        expiryDate: l.expiryDate,
        quantity: l.quantity,
        freeQuantity: l.freeQuantity,
        unit: l.unit,
        conv: l.conv,
        quantityInBase: l.quantityInBase,
        rate: l.rate,
        discountPercent: l.discountPercent,
        grossAmount: l.grossAmount,
        discountAmount: l.discountAmount,
        taxableAmount: l.taxableAmount,
        gstRate: l.gstRate,
        cgst: l.cgst,
        sgst: l.sgst,
        totalAmount: l.totalAmount,
        mrp: l.mrp,
        landingPerUnit: l.landingPerUnit,
        costPerBaseUnit: l.costPerBaseUnit,
        rack: l.rack,
        how: l.how,
        base: u?.base ?? '',
        sale: u?.sale ?? '',
      };
    }),
    subtotal: p.subtotal,
    totalDiscount: p.totalDiscount,
    taxableAmount: p.taxableAmount,
    cgst: p.cgst,
    sgst: p.sgst,
    roundOff: p.roundOff,
    allocations: p.allocations.map((a) => ({ kind: a.kind, refId: a.refId ? String(a.refId) : null, refNumber: a.refNumber ?? null, amount: a.amount, at: a.at })),
    mrpChanges: p.mrpChanges.map((m) => ({ productName: m.productName, batchNumber: m.batchNumber, from: m.from, to: m.to })),
    cancelReason: p.cancelReason ?? null,
    cancelledBy: p.cancelledBy ?? null,
    cancelledAt: p.cancelledAt ?? null,
    advanceLeft: p.advanceLeft ?? null,
    hasPhoto: p.hasPhoto,
    notes: p.notes,
    createdByName: p.createdByName,
    canCancel: p.status === 'active' && cancellable(p.lines, batches, p._id),
  };
}

type BatchState = { _id: Types.ObjectId; purchaseId?: Types.ObjectId | null; quantity: number; status: string };

/** Only while every unit this purchase brought in is still on the shelf (sandbox purchaseOps.canCancel). */
function cancellable(lines: readonly { batchId: Types.ObjectId; quantityInBase: number }[], batches: readonly BatchState[], purchaseId: Types.ObjectId) {
  const byId = new Map(batches.map((b) => [String(b._id), b]));
  return lines.every((l) => {
    const b = byId.get(String(l.batchId));
    return b !== undefined && b.status !== 'returned' && String(b.purchaseId) === String(purchaseId) && b.quantity >= l.quantityInBase;
  });
}

export async function cancel(t: TenantContext, actor: Actor, id: string, reason: string, ip?: string) {
  return inTransaction(async (session) => {
    const now = new Date();
    const p = await PurchaseModel.findOne({ shopId: t.shopId, _id: oid(id) }).session(session).lean();
    if (!p) throw AppError.notFound('Purchase not found');
    if (p.status !== 'active') throw AppError.conflict(`${p.purchaseNumber} is already cancelled`);
    const batches = await BatchModel.find({ shopId: t.shopId, _id: { $in: p.lines.map((l) => l.batchId) } }).session(session).lean();
    if (!cancellable(p.lines, batches, p._id)) throw AppError.conflict('Some of its stock is already sold, moved or merged. Use a purchase return for what is left.', { reason: 'STOCK_USED' });

    for (const l of p.lines) {
      const moved = await applyMove(t.shopId, l.batchId, -l.quantityInBase, { type: 'PURCHASE_CANCEL', refType: 'PURCHASE_CANCEL', refId: p._id, refNumber: p.purchaseNumber, reason, actor, at: now }, session);
      if (moved.after === 0) await BatchModel.updateOne({ shopId: t.shopId, _id: l.batchId }, { $set: { status: 'returned' } }, { session });
    }
    const res = await PurchaseModel.updateOne(
      { shopId: t.shopId, _id: p._id, status: 'active' },
      { $set: { status: 'cancelled', cancelReason: reason, cancelledBy: actor.name, cancelledAt: now, dueAmount: 0, advanceLeft: p.paidAmount } },
      { session },
    );
    if (res.modifiedCount !== 1) throw AppError.conflict(`${p.purchaseNumber} is already cancelled`);
    await reverseInvoice(t.shopId, p.supplierId, p.grandTotal, p.paidAmount, now, session);
    await refreshRollups(t.shopId, [...new Set(p.lines.map((l) => String(l.productId)))].map(oid), session, now);
    await audit(
      {
        shopId: t.shopId,
        userId: actor.id,
        userName: actor.name,
        action: 'cancel',
        module: 'purchases',
        entityId: id,
        entityName: p.purchaseNumber,
        text: `${actor.name} cancelled ${p.purchaseNumber} · reason: ${reason}${p.paidAmount ? ` · ${inr(p.paidAmount)} already paid stays with ${p.supplierName} as advance` : ''}`,
        ip,
      },
      session,
    );
    return { purchaseNumber: p.purchaseNumber, advanceLeft: p.paidAmount };
  });
}
