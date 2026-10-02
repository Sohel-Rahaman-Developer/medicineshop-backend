import type { ClientSession, Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { fyOf } from '../../utils/fy';
import { salePack, type Units } from '../../utils/units';
import { ProductModel } from '../products/product.model';
import { RackModel, type StorageType } from '../racks/rack.model';
import type { Actor } from '../user/actor';
import { BatchModel } from './batch.model';
import { MovementModel, type MovementType } from './movement.model';
import { rollup, type BatchLike } from './stock.domain';

export interface MoveMeta {
  type: MovementType;
  refType: string;
  refId?: Types.ObjectId;
  refNumber?: string;
  reason?: string;
  rackFrom?: string;
  rackTo?: string;
  actor: Actor;
  at: Date;
}

/**
 * The only writer of Batch.quantity (PLAN §12). The `quantity >= need` filter is the lock: two
 * requests can't both take the last strip — the second one finds nothing and gets a 409.
 */
export async function applyMove(shopId: Types.ObjectId, batchId: Types.ObjectId, qty: number, meta: MoveMeta, session: ClientSession) {
  const filter = qty < 0 ? { shopId, _id: batchId, quantity: { $gte: -qty } } : { shopId, _id: batchId };
  const before = await BatchModel.findOneAndUpdate(filter, { $inc: { quantity: qty } }, { session, returnDocument: 'before' }).lean();
  if (!before) throw AppError.conflict('Not enough stock in this batch. Someone may have just used it — reload and try again.');
  await MovementModel.create(
    [
      {
        shopId,
        fy: fyOf(meta.at),
        productId: before.productId,
        batchId,
        type: meta.type,
        quantity: qty,
        balanceBefore: before.quantity,
        balanceAfter: before.quantity + qty,
        costPerBaseUnit: before.costPerBaseUnit,
        refType: meta.refType,
        refId: meta.refId,
        refNumber: meta.refNumber,
        reason: meta.reason,
        rackFrom: meta.rackFrom,
        rackTo: meta.rackTo,
        userId: meta.actor.id,
        userName: meta.actor.name,
        at: meta.at,
      },
    ],
    { session },
  );
  return { before: before.quantity, after: before.quantity + qty, productId: before.productId };
}

async function rollupFor(shopId: Types.ObjectId, productId: Types.ObjectId, now: Date, session?: ClientSession) {
  const product = await ProductModel.findOne({ shopId, _id: productId }).select('reorderLevel units stock.rev').session(session ?? null).lean();
  if (!product) return null;
  const batches = await BatchModel.find({ shopId, productId, status: { $ne: 'returned' } })
    .select('quantity status expiryDate receivedAt costPerBaseUnit mrp')
    .session(session ?? null)
    .lean<BatchLike[]>();
  const pack = salePack(product.units as Units);
  return { rev: product.stock.rev, stock: rollup(batches, { reorderLevel: product.reorderLevel, salePack: pack }, now) };
}

/** Rewrites product rollups inside the caller's transaction; a concurrent change makes the transaction retry. */
export async function refreshRollups(shopId: Types.ObjectId, productIds: Types.ObjectId[], session: ClientSession, now = new Date()) {
  for (const id of productIds) {
    const r = await rollupFor(shopId, id, now, session);
    if (!r) continue;
    await ProductModel.updateOne({ shopId, _id: id }, { $set: { stock: { ...r.stock, rev: r.rev + 1 } } }, { session });
  }
}

/** Expiry only happens at month end, so a rollup goes stale only when its next sellable batch expires. */
export async function refreshStale(shopId: Types.ObjectId, now = new Date()) {
  const stale = await ProductModel.find({ shopId, 'stock.validUntil': { $lt: now } }).select('_id').limit(500).lean();
  for (const p of stale) {
    const r = await rollupFor(shopId, p._id, now);
    if (!r) continue;
    await ProductModel.updateOne({ shopId, _id: p._id, 'stock.rev': r.rev }, { $set: { stock: { ...r.stock, rev: r.rev + 1 } } });
  }
}

/** Rack codes are free text (PLAN §11); an unknown one joins the rack master so it autocompletes next time. */
export async function ensureRack(shopId: Types.ObjectId, code: string, storageType: StorageType, session: ClientSession) {
  if (!code) return;
  await RackModel.updateOne({ shopId, code }, { $setOnInsert: { shopId, code, name: '', storageType, isActive: true } }, { upsert: true, session });
}
