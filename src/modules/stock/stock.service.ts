import { Types, type ClientSession } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { monthLabel } from '../../utils/date';
import { fyOf } from '../../utils/fy';
import { amountFor, inr, rhu } from '../../utils/money';
import { fromBase, salePack, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { nextNumber } from '../counters/counter.model';
import { MembershipModel } from '../memberships/membership.model';
import { photoUrl } from '../products/photo';
import { ProductModel } from '../products/product.model';
import { seesCost } from '../products/products.service';
import { RackModel } from '../racks/rack.model';
import { can } from '../rbac/permissions';
import type { Actor } from '../user/actor';
import { UserModel } from '../user/user.model';
import { askedCounts } from '../demands/demands.service';
import { PurchaseModel } from '../purchases/purchase.model';
import { SupplierModel } from '../suppliers/supplier.model';
import { AdjustmentModel, type AdjustmentType } from './adjustment.model';
import { BatchModel } from './batch.model';
import { MovementModel, type MovementType } from './movement.model';
import { bucketOf, daysLeft, expiryRange, mergedCost, suggestReorder, type ExpiryBucket } from './stock.domain';
import { applyMove, ensureRack, refreshRollups, refreshStale } from './stock.ledger';
import type { AdjustmentInput, ExpiryQuery, MovementsQuery, OpeningInput } from './stock.validation';

const oid = (id: string) => new Types.ObjectId(id);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function productNames(shopId: Types.ObjectId, ids: Types.ObjectId[]) {
  const rows = await ProductModel.find({ shopId, _id: { $in: ids } }).select('name units storageType').lean();
  return new Map(rows.map((p) => [String(p._id), { name: p.name, units: p.units as Units, storageType: p.storageType }]));
}

const unitsBrief = (u?: Units) => (u ? { base: u.base, sale: u.sale, salePack: salePack(u) } : { base: '', sale: '', salePack: 1 });

/** DL2401 taken at another MRP → DL2401-A, then -B (PLAN §9 merge rule, option b). */
async function freeSuffix(shopId: Types.ObjectId, productId: Types.ObjectId, upper: string, session: ClientSession) {
  const taken = await BatchModel.find({ shopId, productId, batchNumberUpper: { $regex: `^${escape(upper)}-[A-Z]$` } }).select('batchNumberUpper').session(session).lean();
  const used = new Set(taken.map((b) => b.batchNumberUpper.slice(-1)));
  const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((l) => !used.has(l));
  if (!letter) throw AppError.conflict('Too many batches share this number and expiry. Use another batch number.');
  return letter;
}

export interface Receive {
  batchNumber: string;
  expiry: Date;
  mfg?: Date;
  quantity: number;
  mrp: number;
  purchaseRate: number;
  rack: string;
  mrpChoice?: 'merge' | 'separate';
}

type ProductForStock = { _id: Types.ObjectId; name: string; units?: unknown; storageType: string; defaultRack: string };

/** Where received stock came from: the ledger entry and the batch's purchase trail. */
export interface ReceiveSource {
  source: 'opening' | 'purchase';
  /** Base units, free goods included. */
  quantity: number;
  freeQuantity: number;
  purchaseRate: number;
  purchaseUnit: string;
  costPerBaseUnit: number;
  supplierId?: Types.ObjectId;
  purchaseId?: Types.ObjectId;
  invoiceNumber?: string;
  refNumber?: string;
}

/** Batch the PLAN §9 merge rule would add to: same product, batch number and expiry. */
export const mergeTarget = (shopId: Types.ObjectId, productId: Types.ObjectId, batchNumber: string, expiry: Date, session?: ClientSession) =>
  BatchModel.findOne({ shopId, productId, batchNumberUpper: batchNumber.toUpperCase(), expiryDate: expiry, status: { $ne: 'returned' } }).session(session ?? null);

export const mrpDiffers = (b: { _id: Types.ObjectId; batchNumber: string; expiryDate: Date; mrp: number }, mrp: number, extra: Record<string, unknown> = {}) =>
  AppError.conflict(`Batch ${b.batchNumber} (exp ${monthLabel(b.expiryDate)}) is already in stock at MRP ${inr(b.mrp)}, not ${inr(mrp)}.`, {
    reason: 'MRP_DIFFERS',
    batch: { id: String(b._id), batchNumber: b.batchNumber, mrp: b.mrp },
    ...extra,
  });

/** Opening stock into a batch with the PLAN §9 merge rule. Runs inside the caller's transaction. */
export async function receiveOpening(shopId: Types.ObjectId, p: ProductForStock, input: Receive, actor: Actor, session: ClientSession, now = new Date()) {
  const pack = salePack(p.units as Units);
  const src: ReceiveSource = { source: 'opening', quantity: input.quantity, freeQuantity: 0, purchaseRate: input.purchaseRate, purchaseUnit: (p.units as Units).sale, costPerBaseUnit: rhu(input.purchaseRate, pack) };
  return receiveBatch(shopId, p, input, src, actor, session, now);
}

/** Puts received stock into a batch (merge, MRP update, or a new -A batch) and writes the ledger entry. */
export async function receiveBatch(shopId: Types.ObjectId, p: ProductForStock, input: Omit<Receive, 'quantity' | 'purchaseRate'>, src: ReceiveSource, actor: Actor, session: ClientSession, now = new Date()) {
  const units = p.units as Units;
  const pack = salePack(units);
  const cost = src.costPerBaseUnit;
  const rack = input.rack || p.defaultRack;
  await ensureRack(shopId, rack, p.storageType === 'COLD' ? 'COLD' : 'NORMAL', session);

  const upper = input.batchNumber.toUpperCase();
  const same = await mergeTarget(shopId, p._id, upper, input.expiry, session);
  let batchId: Types.ObjectId;
  let batchNumber = input.batchNumber;
  let how: 'new' | 'merged' | 'separate' = 'new';
  const mrpBefore = same?.mrp ?? null;
  if (same && (same.mrp === input.mrp || input.mrpChoice === 'merge')) {
    same.set({
      costPerBaseUnit: mergedCost(same.quantity, same.costPerBaseUnit, src.quantity, cost),
      mrp: input.mrp,
      initialQuantity: same.initialQuantity + src.quantity,
      freeQuantity: same.freeQuantity + src.freeQuantity,
    });
    await same.save({ session });
    batchId = same._id;
    batchNumber = same.batchNumber;
    how = 'merged';
  } else if (same && !input.mrpChoice) {
    throw mrpDiffers(same, input.mrp);
  } else {
    if (same) {
      batchNumber = `${input.batchNumber}-${await freeSuffix(shopId, p._id, upper, session)}`;
      how = 'separate';
    }
    const [b] = await BatchModel.create(
      [
        {
          shopId,
          productId: p._id,
          batchNumber,
          batchNumberUpper: batchNumber.toUpperCase(),
          expiryDate: input.expiry,
          mfgDate: input.mfg,
          mrp: input.mrp,
          purchaseRate: src.purchaseRate,
          purchaseUnit: src.purchaseUnit,
          salePack: pack,
          costPerBaseUnit: cost,
          quantity: 0,
          initialQuantity: src.quantity,
          freeQuantity: src.freeQuantity,
          rack,
          source: src.source,
          supplierId: src.supplierId,
          purchaseId: src.purchaseId,
          purchaseInvoiceNumber: src.invoiceNumber,
          receivedAt: now,
        },
      ],
      { session },
    );
    if (!b) throw AppError.internal();
    batchId = b._id;
  }

  const purchase = src.source === 'purchase';
  await applyMove(
    shopId,
    batchId,
    src.quantity,
    { type: purchase ? 'PURCHASE' : 'OPENING', refType: purchase ? 'PURCHASE' : 'OPENING', refId: purchase ? src.purchaseId : batchId, refNumber: src.refNumber ?? batchNumber, actor, at: now },
    session,
  );
  await ProductModel.updateOne({ shopId, _id: p._id }, { $set: { lastMrp: input.mrp } }, { session });
  return { batchId: String(batchId), batchNumber, how, mrpBefore };
}

export async function addOpening(t: TenantContext, actor: Actor, input: OpeningInput, ip?: string) {
  return once(t.shopId, 'opening', input.clientRequestId, async (session) => {
    const p = await ProductModel.findOne({ shopId: t.shopId, _id: oid(input.productId) }).session(session).lean();
    if (!p) throw AppError.notFound('Product not found');
    if (!p.isActive) throw AppError.conflict(`${p.name} is deactivated. Reactivate it first.`);
    const now = new Date();
    const out = await receiveOpening(t.shopId, p, input, actor, session, now);
    await refreshRollups(t.shopId, [p._id], session, now);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'stock', entityId: out.batchId, entityName: `${p.name} · ${out.batchNumber}`, text: `${actor.name} added opening stock: ${fromBase(input.quantity, p.units as Units)} of ${p.name}, batch ${out.batchNumber}`, ip },
      session,
    );
    return out;
  });
}

export async function setBlocked(t: TenantContext, actor: Actor, batchId: string, block: boolean, reason: string, ip?: string) {
  if (block && !reason) throw AppError.validation('A reason is required', [{ field: 'body.reason', message: 'A reason is required' }]);
  return inTransaction(async (session) => {
    const b = await BatchModel.findOne({ shopId: t.shopId, _id: oid(batchId) }).session(session);
    if (!b) throw AppError.notFound('Batch not found');
    if (b.status === 'returned') throw AppError.conflict('This batch went back to the supplier');
    if ((b.status === 'blocked') === block) return { status: b.status };
    b.set(block ? { status: 'blocked', blockedAt: new Date(), blockReason: reason } : { status: 'active', blockedAt: undefined, blockReason: undefined });
    await b.save({ session });
    await refreshRollups(t.shopId, [b.productId], session);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'stock', entityId: batchId, entityName: b.batchNumber, text: `${actor.name} ${block ? 'blocked' : 'unblocked'} batch ${b.batchNumber}${reason ? ` · ${reason}` : ''}`, ip },
      session,
    );
    return { status: b.status };
  });
}

const OUT_TYPE: Record<'DAMAGE' | 'EXPIRY_WRITE_OFF' | 'SELF_USE', MovementType> = { DAMAGE: 'DAMAGE', EXPIRY_WRITE_OFF: 'EXPIRY_WRITE_OFF', SELF_USE: 'SELF_USE' };
const TYPE_LABEL: Record<AdjustmentType, string> = { PHYSICAL_COUNT: 'physical count', DAMAGE: 'damage', EXPIRY_WRITE_OFF: 'expiry write-off', SELF_USE: 'self use', TRANSFER: 'rack transfer' };

export async function adjust(t: TenantContext, actor: Actor, input: AdjustmentInput, ip?: string) {
  if (input.type === 'EXPIRY_WRITE_OFF' && !can(t.permissions, 'stock', 'approve')) {
    throw AppError.forbidden('Write-offs need stock: approve. Ask the owner or a manager.');
  }
  return once(t.shopId, 'adjustment', input.clientRequestId, async (session) => {
    const now = new Date();
    const ids = input.lines.map((l) => oid(l.batchId));
    const batches = await BatchModel.find({ shopId: t.shopId, _id: { $in: ids } }).session(session).lean();
    if (batches.length !== ids.length) throw AppError.notFound('One of the batches was not found');
    const byId = new Map(batches.map((b) => [String(b._id), b]));
    const productIds = [...new Set(batches.map((b) => String(b.productId)))].map(oid);
    const products = await productNames(t.shopId, productIds);
    const returned = batches.find((b) => b.status === 'returned');
    if (returned) throw AppError.conflict(`Batch ${returned.batchNumber} went back to the supplier`);

    if (input.type === 'TRANSFER') {
      const codes = [...new Set(input.lines.map((l) => l.rackTo))];
      const found = await RackModel.countDocuments({ shopId: t.shopId, code: { $in: codes } }).session(session);
      if (found !== codes.length) throw AppError.validation('Choose a rack from the list', [{ field: 'body.lines', message: 'Choose a rack from the list' }]);
    }

    const adjId = new Types.ObjectId();
    const number = await nextNumber(t.shopId, 'adjustment', now, session);
    const meta = (type: MovementType, extra: { rackFrom?: string; rackTo?: string } = {}) => ({ type, refType: 'ADJUSTMENT', refId: adjId, refNumber: number, reason: input.reason, actor, at: now, ...extra });
    const lines = [];
    let totalValue = 0;

    for (const l of input.lines) {
      const b = byId.get(l.batchId);
      if (!b) throw AppError.notFound('Batch not found');
      const p = products.get(String(b.productId));
      const base = { productId: b.productId, productName: p?.name ?? '', batchId: b._id, batchNumber: b.batchNumber, systemQty: b.quantity };
      if ('rackTo' in l) {
        if (b.rack === l.rackTo) throw AppError.validation(`${b.batchNumber} is already on ${l.rackTo}`, [{ field: 'body.lines', message: `${b.batchNumber} is already on ${l.rackTo}` }]);
        await BatchModel.updateOne({ shopId: t.shopId, _id: b._id }, { $set: { rack: l.rackTo } }, { session });
        await applyMove(t.shopId, b._id, 0, meta('RACK_MOVE', { rackFrom: b.rack, rackTo: l.rackTo }), session);
        lines.push({ ...base, actualQty: b.quantity, difference: 0, value: 0, rackFrom: b.rack, rackTo: l.rackTo });
        continue;
      }
      let diff: number;
      if ('counted' in l) {
        if (b.quantity !== l.expected) throw AppError.conflict(`Stock of ${b.batchNumber} changed while you were counting (now ${b.quantity}). Count it again.`);
        diff = l.counted - b.quantity;
        if (diff) await applyMove(t.shopId, b._id, diff, meta(diff > 0 ? 'ADJUST_IN' : 'ADJUST_OUT'), session);
      } else {
        if (l.quantity > b.quantity) throw AppError.conflict(`Only ${b.quantity} ${p?.units.base ?? 'units'} left in ${b.batchNumber}`);
        diff = -l.quantity;
        await applyMove(t.shopId, b._id, diff, meta(OUT_TYPE[input.type as keyof typeof OUT_TYPE]), session);
      }
      const value = diff * b.costPerBaseUnit;
      totalValue += value;
      lines.push({ ...base, actualQty: b.quantity + diff, difference: diff, value });
    }

    await AdjustmentModel.create(
      [
        {
          _id: adjId,
          shopId: t.shopId,
          fy: fyOf(now),
          clientRequestId: input.clientRequestId,
          adjustmentNumber: number,
          type: input.type,
          lines,
          totalValue,
          reason: input.reason,
          notes: input.notes,
          approvedBy: input.type === 'EXPIRY_WRITE_OFF' ? actor.name : undefined,
          createdBy: oid(actor.id),
          createdByName: actor.name,
        },
      ],
      { session },
    );
    await refreshRollups(t.shopId, productIds, session, now);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'stock', entityId: String(adjId), entityName: number, text: `${actor.name} saved ${number} · ${TYPE_LABEL[input.type]} · ${lines.length} ${lines.length === 1 ? 'batch' : 'batches'}`, ip },
      session,
    );
    return { id: String(adjId), adjustmentNumber: number, lines: lines.length, totalValue };
  });
}

export async function listAdjustments(t: TenantContext, cursor: string | undefined, limit: number) {
  const sort = { field: 'createdAt', dir: -1 as const };
  const rows = await AdjustmentModel.find({ shopId: t.shopId, ...afterCursor(cursor, sort) }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = page(rows, limit, (r) => r.createdAt);
  const cost = seesCost(t);
  return {
    items: items.map((a) => ({
      id: String(a._id),
      adjustmentNumber: a.adjustmentNumber,
      type: a.type,
      createdAt: a.createdAt,
      lines: a.lines.length,
      difference: a.lines.reduce((s, l) => s + l.difference, 0),
      reason: a.reason,
      createdByName: a.createdByName,
      approvedBy: a.approvedBy ?? null,
      ...(cost ? { totalValue: a.totalValue } : {}),
    })),
    meta,
  };
}

export async function getAdjustment(t: TenantContext, id: string) {
  const a = await AdjustmentModel.findOne({ shopId: t.shopId, _id: oid(id) }).lean();
  if (!a) throw AppError.notFound('Adjustment not found');
  const cost = seesCost(t);
  const products = await productNames(t.shopId, a.lines.map((l) => l.productId));
  return {
    id: String(a._id),
    adjustmentNumber: a.adjustmentNumber,
    type: a.type,
    createdAt: a.createdAt,
    reason: a.reason,
    notes: a.notes,
    createdByName: a.createdByName,
    approvedBy: a.approvedBy ?? null,
    hasPhoto: a.hasPhoto,
    ...(cost ? { totalValue: a.totalValue } : {}),
    lines: a.lines.map((l) => ({
      productId: String(l.productId),
      productName: l.productName,
      batchId: String(l.batchId),
      batchNumber: l.batchNumber,
      systemQty: l.systemQty,
      actualQty: l.actualQty,
      difference: l.difference,
      rackFrom: l.rackFrom ?? null,
      rackTo: l.rackTo ?? null,
      units: unitsBrief(products.get(String(l.productId))?.units),
      ...(cost ? { value: l.value } : {}),
    })),
  };
}

export async function movements(t: TenantContext, q: MovementsQuery) {
  const sort = { field: 'at', dir: -1 as const };
  const filter: Record<string, unknown> = { shopId: t.shopId };
  if (q.productId) filter.productId = oid(q.productId);
  if (q.batchId) filter.batchId = oid(q.batchId);
  if (q.type) filter.type = q.type;
  if (q.userId) filter.userId = oid(q.userId);
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const after = afterCursor(q.cursor, sort);
  const rows = await MovementModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter)
    .sort({ at: -1, _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const { items, meta } = page(rows, q.limit, (r) => r.at);
  const [products, batches] = await Promise.all([
    productNames(t.shopId, [...new Set(items.map((m) => String(m.productId)))].map(oid)),
    BatchModel.find({ shopId: t.shopId, _id: { $in: items.map((m) => m.batchId) } }).select('batchNumber').lean(),
  ]);
  const bn = new Map(batches.map((b) => [String(b._id), b.batchNumber]));
  return {
    items: items.map((m) => ({
      id: String(m._id),
      at: m.at,
      productId: String(m.productId),
      productName: products.get(String(m.productId))?.name ?? '',
      units: unitsBrief(products.get(String(m.productId))?.units),
      batchId: String(m.batchId),
      batchNumber: bn.get(String(m.batchId)) ?? '',
      type: m.type,
      quantity: m.quantity,
      balanceBefore: m.balanceBefore,
      balanceAfter: m.balanceAfter,
      refType: m.refType,
      refId: m.refId ? String(m.refId) : null,
      refNumber: m.refNumber ?? null,
      reason: m.reason ?? null,
      rackFrom: m.rackFrom ?? null,
      rackTo: m.rackTo ?? null,
      userName: m.userName,
    })),
    meta,
  };
}

/** People who can appear in the ledger: everyone who ever had a place in this shop. */
export async function movementPeople(t: TenantContext) {
  const ms = await MembershipModel.find({ shopId: t.shopId, status: { $in: ['active', 'suspended', 'removed'] } }).select('userId').lean();
  const users = await UserModel.find({ _id: { $in: ms.map((m) => m.userId) } }).select('name email').lean();
  return users.map((u) => ({ id: String(u._id), name: u.name || u.email })).sort((a, b) => a.name.localeCompare(b.name));
}

/** "Why did stock change?" — one batch's ledger summed by type; the sum must equal the batch quantity. */
export async function why(t: TenantContext, batchId: string) {
  const b = await BatchModel.findOne({ shopId: t.shopId, _id: oid(batchId) }).lean();
  if (!b) throw AppError.notFound('Batch not found');
  const p = await ProductModel.findOne({ shopId: t.shopId, _id: b.productId }).select('name units').lean();
  const groups = await MovementModel.aggregate<{ _id: string; quantity: number; count: number; first: Date }>([
    { $match: { shopId: t.shopId, batchId: b._id } },
    { $group: { _id: '$type', quantity: { $sum: '$quantity' }, count: { $sum: 1 }, first: { $min: '$at' } } },
    { $sort: { first: 1 } },
  ]);
  return {
    batch: { id: String(b._id), batchNumber: b.batchNumber, quantity: b.quantity, productId: String(b.productId), productName: p?.name ?? '', units: unitsBrief(p?.units as Units | undefined) },
    byType: groups.map((g) => ({ type: g._id, quantity: g.quantity, count: g.count })),
    ledgerTotal: groups.reduce((s, g) => s + g.quantity, 0),
    count: groups.reduce((s, g) => s + g.count, 0),
    since: groups[0]?.first ?? null,
  };
}

const BUCKETS: Exclude<ExpiryBucket, 'later'>[] = ['expired', 'd30', 'd60', 'd90'];

export async function expiry(t: TenantContext, q: ExpiryQuery) {
  const now = new Date();
  const cost = seesCost(t);
  const live: Record<string, unknown> = { shopId: t.shopId, status: 'active', quantity: { $gt: 0 } };
  const ranges = BUCKETS.map((k) => ({ k, r: expiryRange(k, now) }));
  const summary = await Promise.all(
    ranges.map(async ({ k, r }) => {
      const match: Record<string, unknown> = { ...live, expiryDate: { ...(r.from ? { [k === 'd30' ? '$gte' : '$gt']: r.from } : {}), ...(r.to ? { [k === 'expired' ? '$lt' : '$lte']: r.to } : {}) } };
      const [s] = await BatchModel.aggregate<{ count: number; qty: number; cost: number; mrp: number }>([
        { $match: match },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            qty: { $sum: '$quantity' },
            cost: { $sum: { $multiply: ['$quantity', '$costPerBaseUnit'] } },
            mrp: { $sum: { $floor: { $add: [{ $divide: [{ $multiply: ['$mrp', '$quantity'] }, '$salePack'] }, 0.5] } } },
          },
        },
      ]);
      return { bucket: k, count: s?.count ?? 0, quantity: s?.qty ?? 0, mrpValue: s?.mrp ?? 0, ...(cost ? { value: s?.cost ?? 0 } : {}), match };
    }),
  );
  const chosen = summary.find((s) => s.bucket === q.bucket) ?? summary[0];
  const sort = { field: 'expiryDate', dir: 1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await BatchModel.find(Object.keys(after).length ? { ...chosen?.match, $and: [after] } : (chosen?.match ?? live))
    .sort({ expiryDate: 1, _id: 1 })
    .limit(q.limit + 1)
    .lean();
  const { items, meta } = page(rows, q.limit, (r) => r.expiryDate);
  const products = await productNames(t.shopId, [...new Set(items.map((b) => String(b.productId)))].map(oid));
  const sups = await SupplierModel.find({ shopId: t.shopId, _id: { $in: [...new Set(items.flatMap((b) => (b.supplierId ? [String(b.supplierId)] : [])))].map(oid) } }).select('name').lean();
  const supName = new Map(sups.map((x) => [String(x._id), x.name]));
  return {
    summary: summary.map(({ match: _m, ...s }) => s),
    items: items.map((b) => {
      const p = products.get(String(b.productId));
      return {
        id: String(b._id),
        productId: String(b.productId),
        productName: p?.name ?? '',
        storageType: p?.storageType ?? 'NORMAL',
        units: unitsBrief(p?.units),
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate,
        daysLeft: daysLeft(b.expiryDate, now),
        quantity: b.quantity,
        rack: b.rack,
        source: b.source,
        supplierId: b.supplierId ? String(b.supplierId) : null,
        supplierName: b.supplierId ? (supName.get(String(b.supplierId)) ?? '') : null,
        mrpValue: amountFor(b.mrp, b.quantity, b.salePack),
        ...(cost ? { value: b.quantity * b.costPerBaseUnit } : {}),
      };
    }),
    meta,
  };
}

/** Batches picked elsewhere (expiry centre, a product) brought into an adjustment. */
export async function batchesByIds(t: TenantContext, ids: string[]) {
  const now = new Date();
  const rows = await BatchModel.find({ shopId: t.shopId, _id: { $in: ids.map(oid) }, status: { $ne: 'returned' } }).lean();
  const products = await productNames(t.shopId, [...new Set(rows.map((b) => String(b.productId)))].map(oid));
  const cost = seesCost(t);
  return rows.map((b) => {
    const p = products.get(String(b.productId));
    return {
      id: String(b._id),
      productId: String(b.productId),
      productName: p?.name ?? '',
      units: unitsBrief(p?.units),
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      quantity: b.quantity,
      rack: b.rack,
      bucket: bucketOf(b, now),
      ...(cost ? { costPerBaseUnit: b.costPerBaseUnit } : {}),
    };
  });
}

/** Everything on one rack, for the rack sheet and a rack-wise physical count. */
export async function rackBatches(t: TenantContext, rack: string) {
  const now = new Date();
  const rows = await BatchModel.find({ shopId: t.shopId, rack, status: { $ne: 'returned' }, quantity: { $gt: 0 } }).lean();
  const products = await productNames(t.shopId, [...new Set(rows.map((b) => String(b.productId)))].map(oid));
  return rows
    .map((b) => {
      const p = products.get(String(b.productId));
      return {
        id: String(b._id),
        productId: String(b.productId),
        productName: p?.name ?? '',
        units: unitsBrief(p?.units),
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate,
        quantity: b.quantity,
        bucket: bucketOf(b, now),
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.expiryDate.getTime() - b.expiryDate.getTime());
}

/** Below reorder level or out. Daily sales join in B4; until then the reorder quantity drives the suggestion. */
export async function reorder(t: TenantContext, target: number) {
  await refreshStale(t.shopId);
  const cost = seesCost(t);
  const rows = await ProductModel.find({ shopId: t.shopId, isActive: true, 'stock.status': { $in: ['low', 'out'] } })
    .select('name photo units stock.sellable stock.status reorderLevel reorderQuantity')
    .limit(300)
    .lean();
  const ids = rows.map((p) => p._id);
  const [last, asked] = await Promise.all([lastPurchases(t.shopId, ids), askedCounts(t.shopId, ids)]);
  return rows
    .map((p) => {
      const u = p.units as Units;
      const pack = salePack(u);
      const l = last.get(String(p._id));
      return {
        id: String(p._id),
        name: p.name,
        photo: photoUrl(p.photo),
        units: unitsBrief(u),
        sellable: p.stock.sellable,
        status: p.stock.status,
        reorderLevel: p.reorderLevel,
        reorderQuantity: p.reorderQuantity,
        perDay: 0,
        daysLeft: null,
        suggestion: suggestReorder({ reorderQuantity: p.reorderQuantity, salePack: pack }, p.stock.sellable, 0, target),
        lastSupplier: l ? { id: String(l.supplierId), name: l.supplierName } : null,
        asked: asked.get(String(p._id)) ?? 0,
        ...(cost ? { lastRate: l ? { rate: l.rate, unit: l.unit } : null } : {}),
      };
    })
    .sort((a, b) => a.sellable / Math.max(1, a.reorderLevel) - b.sellable / Math.max(1, b.reorderLevel) || a.name.localeCompare(b.name));
}

/** The newest active purchase line of each product: who sent it last and at what rate. */
export async function lastPurchases(shopId: Types.ObjectId, productIds: Types.ObjectId[]) {
  const rows = await PurchaseModel.aggregate<{ _id: Types.ObjectId; supplierId: Types.ObjectId; supplierName: string; rate: number; unit: string; at: Date }>([
    { $match: { shopId, status: 'active', 'lines.productId': { $in: productIds } } },
    { $sort: { invoiceDate: -1, createdAt: -1 } },
    { $unwind: '$lines' },
    { $match: { 'lines.productId': { $in: productIds } } },
    { $group: { _id: '$lines.productId', supplierId: { $first: '$supplierId' }, supplierName: { $first: '$supplierName' }, rate: { $first: '$lines.rate' }, unit: { $first: '$lines.unit' }, at: { $first: '$invoiceDate' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}
