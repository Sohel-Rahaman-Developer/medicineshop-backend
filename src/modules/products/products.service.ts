import { Types } from 'mongoose';
import { afterCursor, page, sortOf, type SortSpec } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { inTransaction } from '../../core/transaction';
import type { TenantContext } from '../../core/middleware/tenant';
import { versionOf } from '../../core/version';
import { amountFor } from '../../utils/money';
import { purchasePack, salePack, toUnits, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { CategoryModel } from '../categories/category.model';
import { can } from '../rbac/permissions';
import { BatchModel } from '../stock/batch.model';
import { bucketOf, daysLeft, fefo, type BatchLike } from '../stock/stock.domain';
import { ensureRack, refreshRollups, refreshStale } from '../stock/stock.ledger';
import type { Actor } from '../user/actor';
import { photoUrl, processPhoto } from './photo';
import { ProductModel, type Product } from './product.model';
import type { CreateProductInput, ListQuery, UpdateProductInput } from './products.validation';

const DAY = 24 * 60 * 60 * 1000;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const searchKeyOf = (p: { name: string; salt: string; company: string }) => norm(`${p.name} ${p.salt} ${p.company}`);
export const saltKeyOf = (salt: string, strength: string) => (norm(salt) ? `${norm(salt)}|${norm(strength)}` : '');

/** Rate, landing cost and stock value need reports:view (PLAN §7) — without it the fields are not sent at all. */
export const seesCost = (t: TenantContext) => can(t.permissions, 'reports', 'view');

type Lean = Product & { _id: Types.ObjectId; version?: number; createdAt?: Date };

function unitsOut(u: Units) {
  return { ...u, salePack: salePack(u), purchasePack: purchasePack(u) };
}

function stockOut(p: Lean, cost: boolean) {
  const s = p.stock;
  return {
    onHand: s.onHand,
    sellable: s.sellable,
    expired: s.expired,
    blocked: s.blocked,
    batches: s.batches,
    mrpValue: s.mrpValue,
    nextExpiry: s.nextExpiry ?? null,
    status: s.status,
    ...(cost ? { value: s.value } : {}),
  };
}

async function categoryNames(shopId: Types.ObjectId) {
  const cats = await CategoryModel.find({ shopId }).select('name').lean();
  return new Map(cats.map((c) => [String(c._id), c.name]));
}

function detailShape(p: Lean, category: string, cost: boolean) {
  return {
    id: String(p._id),
    name: p.name,
    company: p.company,
    salt: p.salt,
    strength: p.strength,
    categoryId: String(p.categoryId),
    category,
    scheduleType: p.scheduleType,
    storageType: p.storageType,
    hsnCode: p.hsnCode,
    gstRate: p.gstRate,
    barcode: p.barcode ?? '',
    units: unitsOut(p.units as Units),
    packSize: p.packSize,
    defaultRack: p.defaultRack,
    reorderLevel: p.reorderLevel,
    reorderQuantity: p.reorderQuantity,
    photo: photoUrl(p.photo),
    isActive: p.isActive,
    stock: stockOut(p, cost),
    lastMrp: p.lastMrp ?? null,
    createdAt: p.createdAt,
    createdByName: p.createdByName,
    version: p.version ?? 0,
  };
}

const SORTS: Record<ListQuery['sort'], SortSpec> = {
  name: { field: 'nameLower', dir: 1 },
  expiry: { field: 'stock.expirySort', dir: 1 },
  value: { field: 'stock.value', dir: -1 },
};

export async function list(t: TenantContext, q: ListQuery) {
  const now = new Date();
  await refreshStale(t.shopId, now);
  const cost = seesCost(t);
  const sort = SORTS[q.sort === 'value' && !cost ? 'name' : q.sort];
  const filter: Record<string, unknown> = { shopId: t.shopId, isActive: q.status !== 'inactive' };
  const and: Record<string, unknown>[] = [];
  if (q.categoryId) filter.categoryId = new Types.ObjectId(q.categoryId);
  if (q.schedule) filter.scheduleType = q.schedule;
  if (q.status === 'h1') and.push({ scheduleType: { $in: ['H1', 'X'] } });
  if (q.status === 'ok' || q.status === 'low' || q.status === 'out') filter['stock.status'] = q.status;
  if (q.storage) filter.storageType = q.storage;
  if (q.company) filter.company = q.company;
  if (q.expiring) filter['stock.nextExpiry'] = { $ne: null, $lte: new Date(now.getTime() + 90 * DAY) };
  if (q.rack) {
    const ids = await BatchModel.distinct('productId', { shopId: t.shopId, rack: q.rack, quantity: { $gt: 0 }, status: { $ne: 'returned' } });
    filter._id = { $in: ids };
  }
  const tokens = norm(q.q).split(' ').filter(Boolean).slice(0, 6);
  if (tokens.length) {
    const words = { $and: tokens.map((w) => ({ searchKey: { $regex: `(^| )${escape(w)}` } })) };
    and.push(/^[A-Za-z0-9-]{4,32}$/.test(q.q) ? { $or: [{ barcode: q.q }, words] } : words);
  }
  const after = afterCursor(q.cursor, sort);
  if (Object.keys(after).length) and.push(after);
  if (and.length) filter.$and = and;

  const rows = await ProductModel.find(filter).sort(sortOf(sort)).limit(q.limit + 1).lean<Lean[]>();
  const { items, meta } = page(rows, q.limit, (r) => (sort.field === 'nameLower' ? r.nameLower : sort.field === 'stock.value' ? r.stock.value : r.stock.expirySort));

  const [names, batches] = await Promise.all([
    categoryNames(t.shopId),
    BatchModel.find({ shopId: t.shopId, productId: { $in: items.map((p) => p._id) }, status: 'active', quantity: { $gt: 0 }, expiryDate: { $gte: now } })
      .select('productId mrp rack expiryDate receivedAt quantity status costPerBaseUnit')
      .lean(),
  ]);
  const byProduct = new Map<string, typeof batches>();
  for (const b of batches) byProduct.set(String(b.productId), [...(byProduct.get(String(b.productId)) ?? []), b]);

  return {
    items: items.map((p) => {
      const sellable = fefo((byProduct.get(String(p._id)) ?? []) as (BatchLike & { rack: string })[], now);
      const mrps = sellable.map((b) => b.mrp);
      const u = p.units as Units;
      return {
        id: String(p._id),
        name: p.name,
        salt: p.salt,
        strength: p.strength,
        company: p.company,
        category: names.get(String(p.categoryId)) ?? '',
        scheduleType: p.scheduleType,
        storageType: p.storageType,
        units: { base: u.base, sale: u.sale, salePack: salePack(u) },
        photo: photoUrl(p.photo),
        rack: sellable[0]?.rack || p.defaultRack,
        mrp: mrps.length ? { min: Math.min(...mrps), max: Math.max(...mrps) } : null,
        stock: stockOut(p, cost),
      };
    }),
    meta,
  };
}

export async function summary(t: TenantContext) {
  await refreshStale(t.shopId);
  const [s] = await ProductModel.aggregate<Record<string, number>>([
    { $match: { shopId: t.shopId, isActive: true } },
    {
      $group: {
        _id: null,
        products: { $sum: 1 },
        ok: { $sum: { $cond: [{ $eq: ['$stock.status', 'ok'] }, 1, 0] } },
        low: { $sum: { $cond: [{ $eq: ['$stock.status', 'low'] }, 1, 0] } },
        out: { $sum: { $cond: [{ $eq: ['$stock.status', 'out'] }, 1, 0] } },
        cold: { $sum: { $cond: [{ $eq: ['$storageType', 'COLD'] }, 1, 0] } },
        h1: { $sum: { $cond: [{ $in: ['$scheduleType', ['H1', 'X']] }, 1, 0] } },
        value: { $sum: '$stock.value' },
        mrpValue: { $sum: '$stock.mrpValue' },
      },
    },
  ]);
  const n = (k: string) => s?.[k] ?? 0;
  return {
    products: n('products'),
    inStock: n('ok') + n('low'),
    low: n('low'),
    out: n('out'),
    cold: n('cold'),
    h1: n('h1'),
    mrpValue: n('mrpValue'),
    ...(seesCost(t) ? { value: n('value') } : {}),
  };
}

export async function companies(t: TenantContext) {
  const list = await ProductModel.distinct('company', { shopId: t.shopId, isActive: true, company: { $ne: '' } });
  return list.sort((a, b) => a.localeCompare(b));
}

async function load(t: TenantContext, id: string) {
  const p = await ProductModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) }).lean<Lean>();
  if (!p) throw AppError.notFound('Product not found');
  return p;
}

export async function get(t: TenantContext, id: string) {
  await refreshStale(t.shopId);
  const p = await load(t, id);
  const names = await categoryNames(t.shopId);
  return detailShape(p, names.get(String(p.categoryId)) ?? '', seesCost(t));
}

export async function batchesOf(t: TenantContext, id: string) {
  const p = await load(t, id);
  const now = new Date();
  const cost = seesCost(t);
  const pack = salePack(p.units as Units);
  const batches = await BatchModel.find({ shopId: t.shopId, productId: p._id, status: { $ne: 'returned' }, quantity: { $gt: 0 } }).lean();
  const order = fefo(batches, now);
  const next = order[0] ? String(order[0]._id) : null;
  const rank = (b: (typeof batches)[number]) => {
    const i = order.indexOf(b);
    return i >= 0 ? i : order.length + b.expiryDate.getTime() / 1e13;
  };
  return batches
    .sort((a, b) => rank(a) - rank(b))
    .map((b) => ({
      id: String(b._id),
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      daysLeft: daysLeft(b.expiryDate, now),
      quantity: b.quantity,
      mrp: b.mrp,
      mrpValue: amountFor(b.mrp, b.quantity, pack),
      rack: b.rack,
      bucket: bucketOf(b, now),
      sellsNext: String(b._id) === next,
      blockReason: b.status === 'blocked' ? (b.blockReason ?? '') : null,
      source: b.source,
      receivedAt: b.receivedAt,
      ...(cost ? { purchaseRate: b.purchaseRate, purchaseUnit: b.purchaseUnit, costPerBaseUnit: b.costPerBaseUnit, value: b.quantity * b.costPerBaseUnit } : {}),
    }));
}

/** Every lot that came in, newest first — opening stock now, purchases from B3. */
export async function received(t: TenantContext, id: string) {
  const p = await load(t, id);
  const cost = seesCost(t);
  const batches = await BatchModel.find({ shopId: t.shopId, productId: p._id }).sort({ receivedAt: -1, _id: -1 }).limit(100).lean();
  return batches.map((b) => ({
    id: String(b._id),
    batchNumber: b.batchNumber,
    receivedAt: b.receivedAt,
    source: b.source,
    invoiceNumber: b.purchaseInvoiceNumber ?? null,
    quantity: b.initialQuantity,
    mrp: b.mrp,
    expiryDate: b.expiryDate,
    ...(cost ? { purchaseRate: b.purchaseRate, purchaseUnit: b.purchaseUnit } : {}),
  }));
}

/** Same salt + strength + category with sellable stock; the pharmacist confirms (PLAN O20). */
export async function similar(t: TenantContext, id: string) {
  const p = await load(t, id);
  if (!p.saltKey) return [];
  const rows = await ProductModel.find({ shopId: t.shopId, saltKey: p.saltKey, categoryId: p.categoryId, _id: { $ne: p._id }, isActive: true, 'stock.sellable': { $gt: 0 } })
    .sort({ nameLower: 1 })
    .limit(10)
    .lean<Lean[]>();
  return rows.map((x) => ({
    id: String(x._id),
    name: x.name,
    company: x.company,
    salt: x.salt,
    strength: x.strength,
    photo: photoUrl(x.photo),
    units: { base: (x.units as Units).base, sale: (x.units as Units).sale, salePack: salePack(x.units as Units) },
    sellable: x.stock.sellable,
  }));
}

async function assertCategory(t: TenantContext, categoryId: string) {
  const ok = await CategoryModel.exists({ shopId: t.shopId, _id: new Types.ObjectId(categoryId) });
  if (!ok) throw AppError.validation('Choose a category', [{ field: 'body.categoryId', message: 'Choose a category' }]);
}

const onDuplicate = (err: unknown): never => {
  const e = err as { code?: number; keyPattern?: Record<string, number> };
  if (e.code === 11000 && e.keyPattern?.barcode) throw AppError.validation('Another product has this barcode', [{ field: 'body.barcode', message: 'Another product has this barcode' }]);
  if (e.code === 11000) throw AppError.validation('A product with this name already exists', [{ field: 'body.name', message: 'A product with this name already exists' }]);
  throw err;
};

function masterFields(input: CreateProductInput) {
  return {
    name: input.name,
    nameLower: input.name.toLowerCase(),
    searchKey: searchKeyOf(input),
    company: input.company,
    salt: input.salt,
    saltKey: saltKeyOf(input.salt, input.strength),
    strength: input.strength,
    categoryId: new Types.ObjectId(input.categoryId),
    scheduleType: input.scheduleType,
    storageType: input.storageType,
    hsnCode: input.hsnCode,
    gstRate: input.gstRate,
    barcode: input.barcode || undefined,
    units: toUnits(input.units),
    packSize: input.packSize,
    defaultRack: input.defaultRack,
    reorderLevel: input.reorderLevel,
    reorderQuantity: input.reorderQuantity,
  };
}

export async function create(t: TenantContext, actor: Actor, input: CreateProductInput, ip?: string) {
  await assertCategory(t, input.categoryId);
  const photo = input.photo ? { ...(await processPhoto(input.photo)), updatedAt: new Date() } : null;
  const id = await inTransaction(async (session) => {
    await ensureRack(t.shopId, input.defaultRack, input.storageType === 'COLD' ? 'COLD' : 'NORMAL', session);
    const [p] = await ProductModel.create(
      [{ shopId: t.shopId, ...masterFields(input), photo, createdBy: new Types.ObjectId(actor.id), createdByName: actor.name }],
      { session },
    ).catch(onDuplicate);
    if (!p) throw AppError.internal();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'products', entityId: String(p._id), entityName: p.name, text: `${actor.name} added product ${p.name}`, ip }, session);
    return String(p._id);
  });
  return { id };
}

const LOCKED: (keyof ReturnType<typeof unitsOut>)[] = ['type', 'base', 'sale', 'salePack'];

export async function update(t: TenantContext, actor: Actor, id: string, input: UpdateProductInput, ip?: string) {
  const doc = await ProductModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) });
  if (!doc) throw AppError.notFound('Product not found');
  if (versionOf(doc) !== input.version) throw AppError.conflict('Someone else changed this product. Reload to see the latest.');
  await assertCategory(t, input.categoryId);
  const before = unitsOut(doc.units as Units);
  const after = unitsOut(toUnits(input.units));
  if (LOCKED.some((k) => before[k] !== after[k]) && (await BatchModel.exists({ shopId: t.shopId, productId: doc._id }))) {
    throw AppError.conflict('Units can’t change once stock is added: the base unit, sale unit and pack size are fixed now.');
  }
  const photo = input.photo === undefined ? undefined : input.photo === null ? null : { ...(await processPhoto(input.photo)), updatedAt: new Date() };
  await inTransaction(async (session) => {
    await ensureRack(t.shopId, input.defaultRack, input.storageType === 'COLD' ? 'COLD' : 'NORMAL', session);
    doc.set(masterFields(input));
    if (!input.barcode) doc.set('barcode', undefined);
    if (photo !== undefined) doc.set('photo', photo);
    await doc.save({ session }).catch(onDuplicate);
    await refreshRollups(t.shopId, [doc._id], session);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'products', entityId: id, entityName: input.name, text: `${actor.name} updated product ${input.name}`, ip }, session);
  });
}

export async function setActive(t: TenantContext, actor: Actor, id: string, isActive: boolean, version: number, ip?: string) {
  const doc = await ProductModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) });
  if (!doc) throw AppError.notFound('Product not found');
  if (versionOf(doc) !== version) throw AppError.conflict('Someone else changed this product. Reload to see the latest.');
  doc.set('isActive', isActive);
  await doc.save();
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'products', entityId: id, entityName: doc.name, text: `${actor.name} ${isActive ? 'reactivated' : 'deactivated'} ${doc.name}`, ip });
  return { isActive };
}
