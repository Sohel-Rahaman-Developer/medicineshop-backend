import { Types } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { fyOf } from '../../utils/fy';
import { inr } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { nextNumber } from '../counters/counter.model';
import { seesCost } from '../products/products.service';
import { ShopModel } from '../shops/shop.model';
import { BatchModel } from '../stock/batch.model';
import { daysLeftOut, hasExpiry } from '../stock/stock.domain';
import { applyMove, refreshRollups } from '../stock/stock.ledger';
import type { Actor } from '../user/actor';
import { packLabel, returnShare } from './sale.domain';
import { SaleModel } from './sale.model';
import { SaleReturnModel } from './sale-return.model';
import type { ReturnListQuery, SaleReturnInput } from './sales.validation';

const DAY = 24 * 60 * 60 * 1000;
const NEAR_DAYS = 30;
const oid = (id: string) => new Types.ObjectId(id);
const ownOnly = (t: TenantContext) => t.scopes.sales === 'own';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const itemError = (i: number, message: string) => AppError.validation(message, [{ field: `body.items.${String(i)}`, message }]);

/** Whole IST days from the bill to now — the return window counts calendar days (PLAN §15). */
export const ageDays = (billDate: Date, now: Date) => Math.round((Date.parse(istIsoDay(now)) - Date.parse(istIsoDay(billDate))) / DAY);

/**
 * Sale return (PLAN §15): stock goes back into the batch it was sold from. Cashier only on own bills (D20).
 * Outside the window or an expired item is a warning, never a block (D27).
 */
export async function create(t: TenantContext, actor: Actor, input: SaleReturnInput, ip?: string) {
  return once(t.shopId, 'sale-return', input.clientRequestId, async (session) => {
    const now = new Date();
    const filter: Record<string, unknown> = { shopId: t.shopId, _id: oid(input.saleId) };
    if (ownOnly(t)) filter.createdBy = oid(actor.id);
    const s = await SaleModel.findOne(filter).session(session).lean();
    if (!s) throw AppError.notFound('Bill not found');
    if (s.status === 'cancelled') throw AppError.conflict(`${s.billNumber} is cancelled — nothing to return`);
    if (s.status === 'returned') throw AppError.conflict(`Everything on ${s.billNumber} is already returned`);
    const shop = await ShopModel.findOne({ _id: t.shopId }).select('settings.billing').session(session).lean();
    const windowDays = shop?.settings.billing?.saleReturnWindowDays ?? 7;

    const taken = new Map<number, number>();
    const lines = input.items.map((it, i) => {
      const l = s.lines[it.line];
      if (!l) throw itemError(i, 'This line is not on the bill');
      const left = l.quantityInBase - l.returnedQuantity;
      if (it.quantity > left) throw itemError(i, left ? `Only ${packLabel(left, l.salePack, l.unit, l.baseUnit)} of ${l.productName} is left to return` : `${l.productName} is already returned`);
      taken.set(it.line, it.quantity);
      const share = returnShare(l, l.returnedQuantity, it.quantity);
      const dl = daysLeftOut(l.expiryDate, now);
      return {
        lineIndex: it.line,
        productId: l.productId,
        productName: l.productName,
        hsn: l.hsn,
        batchId: l.batchId,
        batchNumber: l.batchNumber,
        expiryDate: l.expiryDate,
        quantity: it.quantity,
        unit: l.unit,
        baseUnit: l.baseUnit,
        salePack: l.salePack,
        mrp: l.mrp,
        gstRate: l.gstRate,
        ...share,
        lineCost: it.quantity * l.costPerBaseUnit,
        reason: it.reason,
        expired: dl !== null && dl < 0,
        nearExpiry: dl !== null && dl >= 0 && dl <= NEAR_DAYS,
      };
    });
    // The bill's round-off goes back with the return that empties the bill, so a full return refunds what was paid.
    const complete = s.lines.every((l, i) => l.returnedQuantity + (taken.get(i) ?? 0) >= l.quantityInBase);
    const roundOff = complete ? s.roundOff : 0;
    const sum = (k: 'amount' | 'taxable' | 'cgst' | 'sgst' | 'igst' | 'tax' | 'lineCost') => lines.reduce((a, l) => a + l[k], 0);
    const total = sum('amount') + roundOff;
    if (input.expectedTotal !== undefined && input.expectedTotal !== total) {
      throw AppError.conflict(`The refund is now ${inr(total)} — the bill changed. Check and save again.`, { reason: 'TOTAL_CHANGED', total });
    }

    // The lock: every line must still have what we read, so two returns can't both take the last strip back.
    const cond: Record<string, unknown> = {};
    const inc: Record<string, number> = {};
    for (const l of lines) {
      cond[`lines.${String(l.lineIndex)}.returnedQuantity`] = s.lines[l.lineIndex]?.returnedQuantity ?? 0;
      inc[`lines.${String(l.lineIndex)}.returnedQuantity`] = l.quantity;
    }
    const done = await SaleModel.updateOne(
      { shopId: t.shopId, _id: s._id, status: { $in: ['completed', 'partially_returned'] }, ...cond },
      { $inc: inc, $set: { status: complete ? 'returned' : 'partially_returned' } },
      { session },
    );
    if (!done.modifiedCount) throw AppError.conflict(`${s.billNumber} changed meanwhile — reload`);

    const id = new Types.ObjectId();
    const returnNumber = await nextNumber(t.shopId, 'saleReturn', now, session);
    const creditNoteNumber = input.refundMode === 'CREDIT_NOTE' ? await nextNumber(t.shopId, 'creditNote', now, session) : undefined;
    for (const l of lines) {
      await BatchModel.updateOne({ shopId: t.shopId, _id: l.batchId, status: 'returned' }, { $set: { status: 'active' } }, { session });
      await applyMove(t.shopId, l.batchId, l.quantity, { type: 'SALE_RETURN', refType: 'SALE_RETURN', refId: id, refNumber: returnNumber, reason: `${s.billNumber} · ${l.reason}`, actor, at: now }, session);
    }
    await refreshRollups(t.shopId, [...new Set(lines.map((l) => String(l.productId)))].map(oid), session, now);
    const age = ageDays(s.billDate, now);
    const outsideWindow = age > windowDays;
    await SaleReturnModel.create(
      [
        {
          _id: id,
          shopId: t.shopId,
          fy: fyOf(now),
          clientRequestId: input.clientRequestId,
          returnNumber,
          creditNoteNumber,
          saleId: s._id,
          billNumber: s.billNumber,
          billDate: s.billDate,
          saleCreatedBy: s.createdBy,
          customerName: s.customerName,
          customerPhone: s.customerPhone,
          returnDate: now,
          reason: lines[0]?.reason ?? '',
          ageDays: age,
          windowDays,
          outsideWindow,
          lines,
          taxableAmount: sum('taxable'),
          cgst: sum('cgst'),
          sgst: sum('sgst'),
          igst: sum('igst'),
          totalTax: sum('tax'),
          roundOff,
          total,
          refundMode: input.refundMode,
          cashBack: input.refundMode === 'CASH' ? total : 0,
          totalCost: sum('lineCost'),
          createdBy: oid(actor.id),
          createdByName: actor.name,
        },
      ],
      { session },
    );
    const flags = [outsideWindow ? `${String(age)} days after the bill (window ${String(windowDays)})` : '', lines.some((l) => l.expired) ? 'expired item taken back' : ''].filter(Boolean);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'sales', entityId: String(id), entityName: returnNumber, text: `${actor.name} took back ${String(lines.length)} ${lines.length === 1 ? 'line' : 'lines'} of ${s.billNumber} · ${inr(total)} ${input.refundMode === 'CASH' ? 'cash' : `credit note ${creditNoteNumber ?? ''}`}${flags.length ? ` · ${flags.join(' · ')}` : ''}`, ip },
      session,
    );
    return { id: String(id), returnNumber, creditNoteNumber: creditNoteNumber ?? null, billNumber: s.billNumber, saleId: String(s._id), total, refundMode: input.refundMode, outsideWindow };
  });
}

type ReturnLean = NonNullable<Awaited<ReturnType<typeof findReturn>>>;
async function findReturn(t: TenantContext, userId: string, id: string) {
  const filter: Record<string, unknown> = { shopId: t.shopId, _id: oid(id) };
  if (ownOnly(t)) filter.saleCreatedBy = oid(userId);
  return SaleReturnModel.findOne(filter).lean();
}

function shape(r: ReturnLean, cost: boolean) {
  return {
    id: String(r._id),
    returnNumber: r.returnNumber,
    creditNoteNumber: r.creditNoteNumber ?? null,
    saleId: String(r.saleId),
    billNumber: r.billNumber,
    billDate: r.billDate,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    returnDate: r.returnDate,
    reason: r.reason,
    ageDays: r.ageDays,
    windowDays: r.windowDays,
    outsideWindow: r.outsideWindow,
    lines: r.lines.map((l) => ({
      lineIndex: l.lineIndex,
      productId: String(l.productId),
      productName: l.productName,
      hsn: l.hsn,
      batchNumber: l.batchNumber,
      expiryDate: hasExpiry(l.expiryDate) ? l.expiryDate : null,
      quantity: l.quantity,
      unit: l.unit,
      baseUnit: l.baseUnit,
      salePack: l.salePack,
      mrp: l.mrp,
      gstRate: l.gstRate,
      amount: l.amount,
      taxable: l.taxable,
      cgst: l.cgst,
      sgst: l.sgst,
      igst: l.igst,
      reason: l.reason,
      expired: l.expired,
      nearExpiry: l.nearExpiry,
      ...(cost ? { lineCost: l.lineCost } : {}),
    })),
    taxableAmount: r.taxableAmount,
    cgst: r.cgst,
    sgst: r.sgst,
    igst: r.igst,
    totalTax: r.totalTax,
    roundOff: r.roundOff,
    total: r.total,
    refundMode: r.refundMode,
    cashBack: r.cashBack,
    createdByName: r.createdByName,
    ...(cost ? { totalCost: r.totalCost } : {}),
  };
}

export async function get(t: TenantContext, userId: string, id: string) {
  const r = await findReturn(t, userId, id);
  if (!r) throw AppError.notFound('Return not found');
  return shape(r, seesCost(t));
}

export async function forPdf(t: TenantContext, userId: string, id: string) {
  const r = await findReturn(t, userId, id);
  if (!r) throw AppError.notFound('Return not found');
  return shape(r, false);
}

export async function list(t: TenantContext, userId: string, q: ReturnListQuery) {
  const filter: Record<string, unknown> = { shopId: t.shopId };
  if (ownOnly(t)) filter.saleCreatedBy = oid(userId);
  if (q.saleId) filter.saleId = oid(q.saleId);
  if (q.q) {
    const rx = { $regex: `${escape(q.q.toUpperCase())}$` };
    filter.$or = [{ returnNumber: rx }, { billNumber: rx }, { creditNoteNumber: rx }];
  }
  if (q.from || q.to) filter.returnDate = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: new Date(q.to.getTime() + DAY - 1) } : {}) };
  const sort = { field: 'returnDate', dir: -1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await SaleReturnModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter)
    .sort({ returnDate: -1, _id: -1 })
    .limit(q.limit + 1)
    .select('returnNumber creditNoteNumber saleId billNumber customerName returnDate total refundMode outsideWindow lines.productName createdByName')
    .lean();
  const { items, meta } = page(rows, q.limit, (r) => r.returnDate);
  return {
    items: items.map((r) => ({
      id: String(r._id),
      returnNumber: r.returnNumber,
      creditNoteNumber: r.creditNoteNumber ?? null,
      saleId: String(r.saleId),
      billNumber: r.billNumber,
      customerName: r.customerName,
      returnDate: r.returnDate,
      items: r.lines.length,
      firstItem: r.lines[0]?.productName ?? '',
      total: r.total,
      refundMode: r.refundMode,
      outsideWindow: r.outsideWindow,
      createdByName: r.createdByName,
    })),
    meta,
  };
}
