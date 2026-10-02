import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { audit } from '../audit/audit.model';
import { ProductModel } from '../products/product.model';
import { seesCost } from '../products/products.service';
import { BatchModel } from '../stock/batch.model';
import { bucketOf } from '../stock/stock.domain';
import type { Actor } from '../user/actor';
import { RackModel, type StorageType } from './rack.model';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function list(t: TenantContext) {
  const cost = seesCost(t);
  const [racks, stats] = await Promise.all([
    RackModel.find({ shopId: t.shopId }).sort({ code: 1 }).lean(),
    BatchModel.aggregate<{ _id: string; products: Types.ObjectId[]; cost: number; mrp: number }>([
      { $match: { shopId: t.shopId, status: { $ne: 'returned' }, quantity: { $gt: 0 } } },
      {
        $group: {
          _id: '$rack',
          products: { $addToSet: '$productId' },
          cost: { $sum: { $multiply: ['$quantity', '$costPerBaseUnit'] } },
          mrp: { $sum: { $floor: { $add: [{ $divide: [{ $multiply: ['$mrp', '$quantity'] }, '$salePack'] }, 0.5] } } },
        },
      },
    ]),
  ]);
  const byCode = new Map(stats.map((s) => [s._id, s]));
  return racks.map((r) => {
    const s = byCode.get(r.code);
    return { id: String(r._id), code: r.code, name: r.name, storageType: r.storageType, products: s?.products.length ?? 0, mrpValue: s?.mrp ?? 0, ...(cost ? { value: s?.cost ?? 0 } : {}) };
  });
}

export async function create(t: TenantContext, actor: Actor, input: { code: string; name: string; storageType: StorageType }, ip?: string) {
  const exists = await RackModel.exists({ shopId: t.shopId, code: input.code });
  if (exists) throw AppError.validation('This rack already exists', [{ field: 'body.code', message: 'This rack already exists' }]);
  const r = await RackModel.create({ shopId: t.shopId, ...input });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'stock', entityId: String(r._id), entityName: r.code, text: `${actor.name} added rack ${r.code}`, ip });
  return { id: String(r._id), code: r.code };
}

/** Renaming a rack moves every batch and default rack on it — the code is what batches store. */
export async function update(t: TenantContext, actor: Actor, id: string, input: { code: string; name: string; storageType: StorageType }, ip?: string) {
  return inTransaction(async (session) => {
    const r = await RackModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) }).session(session);
    if (!r) throw AppError.notFound('Rack not found');
    const old = r.code;
    if (old !== input.code && (await RackModel.exists({ shopId: t.shopId, code: input.code }).session(session))) {
      throw AppError.validation('This rack already exists', [{ field: 'body.code', message: 'This rack already exists' }]);
    }
    r.set(input);
    await r.save({ session });
    if (old !== input.code) {
      await BatchModel.updateMany({ shopId: t.shopId, rack: old }, { $set: { rack: input.code } }, { session });
      await ProductModel.updateMany({ shopId: t.shopId, defaultRack: old }, { $set: { defaultRack: input.code } }, { session });
    }
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'stock', entityId: id, entityName: input.code, text: old === input.code ? `${actor.name} updated rack ${old}` : `${actor.name} renamed rack ${old} to ${input.code}`, ip },
      session,
    );
    return { id, code: input.code };
  });
}

/** "Where is Dolo?" → Dolo 650 → A-2-1 (DL2401), A-2-1 (DL2409). */
export async function find(t: TenantContext, q: string) {
  const now = new Date();
  const words = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const products = await ProductModel.find({ shopId: t.shopId, isActive: true, $and: words.map((w) => ({ searchKey: { $regex: `(^| )${escape(w)}` } })) })
    .select('name storageType')
    .sort({ nameLower: 1 })
    .limit(5)
    .lean();
  const batches = await BatchModel.find({ shopId: t.shopId, productId: { $in: products.map((p) => p._id) }, status: { $ne: 'returned' }, quantity: { $gt: 0 } })
    .select('productId rack batchNumber expiryDate status quantity')
    .sort({ expiryDate: 1 })
    .lean();
  return products.map((p) => ({
    id: String(p._id),
    name: p.name,
    cold: p.storageType === 'COLD',
    places: batches.filter((b) => b.productId.equals(p._id) && bucketOf(b, now)).map((b) => ({ rack: b.rack, batchNumber: b.batchNumber })),
  }));
}
