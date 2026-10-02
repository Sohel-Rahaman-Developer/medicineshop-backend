import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { audit } from '../audit/audit.model';
import { ProductModel } from '../products/product.model';
import type { Actor } from '../user/actor';
import { CategoryModel, categoryKey } from './category.model';

export async function list(t: TenantContext) {
  const [cats, counts] = await Promise.all([
    CategoryModel.find({ shopId: t.shopId }).sort({ isSystem: -1, name: 1 }).lean(),
    ProductModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { shopId: t.shopId } },
      { $group: { _id: '$categoryId', n: { $sum: 1 } } },
    ]),
  ]);
  const count = new Map(counts.map((c) => [String(c._id), c.n]));
  return cats.map((c) => ({ id: String(c._id), name: c.name, isSystem: c.isSystem, products: count.get(String(c._id)) ?? 0 }));
}

export async function create(t: TenantContext, actor: Actor, name: string, ip?: string) {
  const key = categoryKey(name);
  if (!key) throw AppError.validation('Give the category a name', [{ field: 'body.name', message: 'Give the category a name' }]);
  const clash = await CategoryModel.findOne({ shopId: t.shopId, key }).lean();
  if (clash) throw AppError.conflict(`Already exists as “${clash.name}”`, { existing: { id: String(clash._id), name: clash.name } });
  const cat = await CategoryModel.create({ shopId: t.shopId, name, key, isSystem: false, createdBy: new Types.ObjectId(actor.id) });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'products', entityId: String(cat._id), entityName: name, text: `${actor.name} added product category ${name}`, ip });
  return { id: String(cat._id), name: cat.name, isSystem: false, products: 0 };
}

export async function remove(t: TenantContext, actor: Actor, id: string, ip?: string) {
  const cat = await CategoryModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) }).lean();
  if (!cat) throw AppError.notFound('Category not found');
  if (cat.isSystem) throw AppError.forbidden('Built-in categories can’t be removed');
  const used = await ProductModel.countDocuments({ shopId: t.shopId, categoryId: cat._id });
  if (used) throw AppError.conflict(`${used} ${used === 1 ? 'product uses' : 'products use'} this category. Move them first.`);
  await CategoryModel.deleteOne({ shopId: t.shopId, _id: cat._id });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'delete', module: 'products', entityId: id, entityName: cat.name, text: `${actor.name} removed product category ${cat.name}`, ip });
}
