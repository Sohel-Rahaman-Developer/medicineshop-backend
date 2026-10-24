import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { categoryRequestEmail } from '../../services/email-templates';
import { queueMail } from '../../services/mail-queue';
import { AdminAuditModel, AdminUserModel } from '../admin/admin.model';
import { audit } from '../audit/audit.model';
import { emit } from '../notifications/notifications.service';
import { ProductModel } from '../products/product.model';
import { ShopModel } from '../shops/shop.model';
import type { Actor } from '../user/actor';
import { CategoryRequestModel } from './category-request.model';
import { CategoryModel, SYSTEM_CATEGORIES, categoryKey } from './category.model';

const LINK_DAYS = 7;
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

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

/** This shop's asks still waiting, or turned down in the last 30 days. */
export async function requests(t: TenantContext) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await CategoryRequestModel.find({ 'shops.shopId': t.shopId, $or: [{ status: 'pending' }, { status: 'rejected', decidedAt: { $gte: since } }] }).sort({ createdAt: -1 }).lean();
  return rows.map((r) => ({ id: String(r._id), name: r.name, status: r.status, at: r.shops.find((s) => s.shopId.equals(t.shopId))?.at ?? r.createdAt, reason: r.status === 'rejected' ? r.reason : '' }));
}

type Added = { status: 'added'; category: { id: string; name: string; isSystem: boolean; products: number } };
type Pending = { status: 'pending'; name: string; already: boolean };

/** A new category is only asked for: MedBox24 approves it once, then every shop gets it. */
export async function create(t: TenantContext, actor: Actor, name: string, ip?: string): Promise<Added | Pending> {
  const key = categoryKey(name);
  if (!key) throw AppError.validation('Give the category a name', [{ field: 'body.name', message: 'Give the category a name' }]);
  const clash = await CategoryModel.findOne({ shopId: t.shopId, key }).lean();
  if (clash) throw AppError.conflict(`Already exists as “${clash.name}”`, { existing: { id: String(clash._id), name: clash.name } });

  const shop = await ShopModel.findById(t.shopId).select('name').lean();
  const asker = { shopId: t.shopId, shopName: shop?.name ?? 'A shop', userName: actor.name, at: new Date() };
  const known = await CategoryRequestModel.findOne({ key }).lean();
  if (known?.status === 'approved') {
    // Approved before this shop existed in the list: hand it over now.
    const cat = await CategoryModel.create({ shopId: t.shopId, name: known.name, key, isSystem: true });
    return { status: 'added', category: { id: String(cat._id), name: cat.name, isSystem: true, products: 0 } };
  }
  if (known?.status === 'rejected') throw AppError.conflict(known.reason ? `MedBox24 did not add “${known.name}” as a category: ${known.reason}. Pick the nearest one.` : `MedBox24 did not add “${known.name}” as a category. Pick the nearest one.`, { rejected: true });
  if (known) {
    const mine = known.shops.some((s) => s.shopId.equals(t.shopId));
    if (!mine) await CategoryRequestModel.updateOne({ _id: known._id }, { $push: { shops: asker } });
    return { status: 'pending', name: known.name, already: true };
  }

  const admins = await AdminUserModel.find({ role: 'super', status: 'active' }).select('email').lean();
  const tokens = admins.map((a) => ({ adminId: a._id, email: a.email, token: randomBytes(24).toString('base64url') }));
  const req = await CategoryRequestModel.create({ name, key, shops: [asker], links: tokens.map((x) => ({ adminId: x.adminId, hash: hashOf(x.token) })), linksExpire: new Date(Date.now() + LINK_DAYS * 86_400_000) }).catch((err: unknown) => {
    // Two shops asking at the same moment: the second joins the first.
    if ((err as { code?: number }).code === 11000) return null;
    throw err;
  });
  if (!req) {
    await CategoryRequestModel.updateOne({ key, 'shops.shopId': { $ne: t.shopId } }, { $push: { shops: asker } });
    return { status: 'pending', name, already: true };
  }
  for (const x of tokens) {
    const mail = categoryRequestEmail({ name, shopName: asker.shopName, userName: actor.name, link: `${env.ADMIN_APP_URL}/category-request/${x.token}`, days: LINK_DAYS });
    await queueMail({ kind: 'category_request', to: x.email, ...mail });
  }
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'products', entityId: String(req._id), entityName: name, text: `${actor.name} asked MedBox24 for a new product category ${name}`, ip });
  return { status: 'pending', name, already: false };
}

export async function remove(t: TenantContext, actor: Actor, id: string, ip?: string) {
  const cat = await CategoryModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) }).lean();
  if (!cat) throw AppError.notFound('Category not found');
  if (cat.isSystem) throw AppError.forbidden('Built-in categories can’t be removed');
  const used = await ProductModel.countDocuments({ shopId: t.shopId, categoryId: cat._id });
  if (used) throw AppError.conflict(used === 1 ? '1 product uses this category. Move it first.' : `${String(used)} products use this category. Move them first.`);
  await CategoryModel.deleteOne({ shopId: t.shopId, _id: cat._id });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'delete', module: 'products', entityId: id, entityName: cat.name, text: `${actor.name} removed product category ${cat.name}`, ip });
}

/** Approved categories, for a shop made today. */
export async function approvedNames(): Promise<string[]> {
  return (await CategoryRequestModel.find({ status: 'approved' }).select('name').sort({ decidedAt: 1 }).lean()).map((r) => r.name);
}

function shape(r: { _id: Types.ObjectId; name: string; status: string; shops: { shopName: string; userName: string; at: Date }[]; createdAt?: Date; decidedBy?: string | null; decidedVia?: string | null; decidedAt?: Date | null; reason?: string }) {
  return { id: String(r._id), name: r.name, status: r.status, shops: r.shops.map((s) => ({ shopName: s.shopName, userName: s.userName, at: s.at })), at: r.createdAt ?? null, decidedBy: r.decidedBy ?? null, decidedVia: r.decidedVia ?? null, decidedAt: r.decidedAt ?? null, reason: r.reason ?? '' };
}

/** Admin console: every ask, newest first. */
export async function adminList() {
  const rows = await CategoryRequestModel.find({}).sort({ status: 1, createdAt: -1 }).limit(200).lean();
  return rows.map(shape);
}

const builtIn = async () => [...SYSTEM_CATEGORIES, ...(await approvedNames())];

/** The email link: the ask and what already exists, so a near-duplicate is easy to spot. */
export async function byLink(token: string) {
  const r = await CategoryRequestModel.findOne({ 'links.hash': hashOf(token) }).lean();
  const x = r ?? (await CategoryRequestModel.findOne({ usedHashes: hashOf(token) }).lean());
  if (!x) throw AppError.notFound('This link is not valid any more — open Category requests in the admin console');
  return { ...shape(x), expired: x.linksExpire.getTime() < Date.now(), existing: await builtIn() };
}

export async function decide(id: Types.ObjectId, by: { id: string; name: string }, decision: 'approve' | 'reject', reason: string, via: 'email' | 'console', ip?: string) {
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const why = reason.trim() || (decision === 'approve' ? 'New category for every shop' : 'Not a separate category');
  // Every emailed link stops working, yet still opens the page that says who decided.
  const used = ((await CategoryRequestModel.findById(id).select('links').lean())?.links ?? []).map((l) => l.hash);
  const r = await CategoryRequestModel.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status, decidedBy: by.name, decidedVia: via, decidedAt: new Date(), reason: reason.trim(), links: [] }, $addToSet: { usedHashes: { $each: used } } }, { new: true }).lean();
  if (!r) {
    const now = await CategoryRequestModel.findById(id).lean();
    if (!now) throw AppError.notFound('Request not found');
    throw AppError.conflict(`Already ${now.status} by ${now.decidedBy ?? 'MedBox24'}`);
  }
  if (decision === 'approve') {
    const shops = await ShopModel.find({}).select('_id').lean();
    if (shops.length) {
      await CategoryModel.bulkWrite(shops.map((s) => ({ updateOne: { filter: { shopId: s._id, key: r.key }, update: { $setOnInsert: { shopId: s._id, key: r.key, name: r.name, isSystem: true } }, upsert: true } })), { ordered: false });
    }
  }
  for (const s of r.shops) {
    await emit(s.shopId, decision === 'approve'
      ? { key: `CATEGORY:${String(r._id)}`, type: 'CATEGORY_DECIDED', priority: 'low', title: `“${r.name}” is now a category`, body: 'MedBox24 approved it — pick it on any product.', route: '/settings/inventory', perm: { module: 'products', action: 'view' } }
      : { key: `CATEGORY:${String(r._id)}`, type: 'CATEGORY_DECIDED', priority: 'low', title: `MedBox24 did not add “${r.name}”`, body: reason.trim() || 'Pick the nearest category instead.', route: '/settings/inventory', perm: { module: 'products', action: 'view' } });
  }
  await AdminAuditModel.create({ adminUserId: new Types.ObjectId(by.id), adminName: by.name, action: `category_${decision}`, reason: why, text: `${decision === 'approve' ? 'approved' : 'turned down'} the product category ${r.name}${via === 'email' ? ' from the email link' : ''}`, ip });
  return shape(r);
}

/** One tap from the email: the link names the admin, and it works once. */
export async function decideByLink(token: string, decision: 'approve' | 'reject', reason: string, ip?: string) {
  const hash = hashOf(token);
  const r = await CategoryRequestModel.findOne({ 'links.hash': hash }).lean();
  if (!r) throw AppError.notFound('This link is not valid any more — open Category requests in the admin console');
  if (r.linksExpire.getTime() < Date.now()) throw AppError.conflict('This link has expired — open Category requests in the admin console');
  const adminId = r.links.find((l) => l.hash === hash)?.adminId;
  const admin = adminId ? await AdminUserModel.findOne({ _id: adminId, role: 'super', status: 'active' }).select('name').lean() : null;
  if (!admin) throw AppError.forbidden('Only an active super admin can decide');
  return decide(r._id, { id: String(admin._id), name: admin.name }, decision, reason, 'email', ip);
}
