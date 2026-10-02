import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { objectId } from '../../core/zod';
import { audit } from '../audit/audit.model';
import { ProductModel } from '../products/product.model';
import type { Actor } from '../user/actor';
import { DemandModel } from './demand.model';

const oid = (id: string) => new Types.ObjectId(id);

export const demandSchema = z
  .object({
    productId: objectId.optional(),
    name: z.string().trim().max(120).default(''),
    qty: z.string().trim().max(40).default(''),
    note: z.string().trim().max(120).default(''),
  })
  .strict()
  .refine((v) => v.productId || v.name.length >= 2, { message: 'Type the medicine name', path: ['name'] });
export const linkSchema = z.object({ ids: z.array(objectId).min(1).max(100), productId: objectId }).strict();
export type DemandInput = z.infer<typeof demandSchema>;

const shape = (d: { _id: Types.ObjectId; productId?: Types.ObjectId | null; name: string; qty: string; note: string; status: string; createdByName: string; at: Date }) => ({
  id: String(d._id),
  productId: d.productId ? String(d.productId) : null,
  name: d.name,
  qty: d.qty,
  note: d.note,
  status: d.status,
  by: d.createdByName,
  at: d.at,
});

export async function list(t: TenantContext) {
  const rows = await DemandModel.find({ shopId: t.shopId, status: 'open' }).sort({ at: -1, _id: -1 }).limit(500).lean();
  return rows.map(shape);
}

export async function add(t: TenantContext, actor: Actor, input: DemandInput) {
  let name = input.name;
  let productId: Types.ObjectId | null = null;
  if (input.productId) {
    const p = await ProductModel.findOne({ shopId: t.shopId, _id: oid(input.productId) }).select('name').lean();
    if (!p) throw AppError.notFound('Product not found');
    name = p.name;
    productId = p._id;
  }
  const d = await DemandModel.create({ shopId: t.shopId, productId, name, nameLower: name.toLowerCase(), qty: input.qty, note: input.note, createdBy: oid(actor.id), createdByName: actor.name, at: new Date() });
  return shape(d.toObject());
}

/** Lines written as a name join the product once it exists (PLAN §35.2). */
export async function link(t: TenantContext, actor: Actor, ids: string[], productId: string, ip?: string) {
  const p = await ProductModel.findOne({ shopId: t.shopId, _id: oid(productId) }).select('name').lean();
  if (!p) throw AppError.notFound('Product not found');
  const res = await DemandModel.updateMany(
    { shopId: t.shopId, _id: { $in: ids.map(oid) }, productId: null, status: 'open' },
    { $set: { productId: p._id, name: p.name, nameLower: p.name.toLowerCase() } },
  );
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'products', entityId: productId, entityName: p.name, text: `${actor.name} linked ${String(res.modifiedCount)} buy-list ${res.modifiedCount === 1 ? 'line' : 'lines'} to ${p.name}`, ip });
  return { linked: res.modifiedCount };
}

export async function clear(t: TenantContext, actor: Actor, ids: string[]) {
  const res = await DemandModel.updateMany({ shopId: t.shopId, _id: { $in: ids.map(oid) }, status: 'open' }, { $set: { status: 'cleared', clearedBy: actor.name, clearedAt: new Date() } });
  return { cleared: res.modifiedCount };
}

/** Open asks per product, for the reorder list's "Asked 2×". */
export async function askedCounts(shopId: Types.ObjectId, productIds: Types.ObjectId[]) {
  const rows = await DemandModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { shopId, status: 'open', productId: { $in: productIds } } },
    { $group: { _id: '$productId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}
