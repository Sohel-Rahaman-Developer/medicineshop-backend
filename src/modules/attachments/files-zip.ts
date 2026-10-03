import type { Writable } from 'node:stream';
import type { Response } from 'express';
import type { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { ZIP_MAX_BYTES, ZIP_MAX_FILES, ZipWriter } from '../../core/zip';
import { bytesOf } from '../products/photo';
import { ProductModel } from '../products/product.model';
import { PurchaseModel } from '../purchases/purchase.model';
import { ShopModel } from '../shops/shop.model';
import { AdjustmentModel } from '../stock/adjustment.model';
import { AttachmentModel } from './attachment.model';

const IST = 5.5 * 60 * 60 * 1000;
const month = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 7);
const slug = (s: string, max = 60) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'item';
const csv = (cells: (string | number)[]) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
const running = new Set<string>();
const busy = () => AppError.conflict('A ZIP for this shop is already being made — wait for it to finish');

/** One folder per shop, named after it and kept unique by its id; the shop name in a file is only a label. */
export async function filesInfo(shopId: Types.ObjectId) {
  const shop = await ShopModel.findById(shopId).select('name').lean();
  if (!shop) throw AppError.notFound('Shop not found');
  const [p, a] = await Promise.all([
    ProductModel.aggregate<{ n: number; bytes: number }>([{ $match: { shopId, photo: { $ne: null } } }, { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$photo.bytes' } } }]),
    AttachmentModel.aggregate<{ n: number; bytes: number }>([{ $match: { shopId } }, { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$bytes' } } }]),
  ]);
  const files = (p[0]?.n ?? 0) + (a[0]?.n ?? 0);
  const bytes = (p[0]?.bytes ?? 0) + (a[0]?.bytes ?? 0);
  const folder = `${slug(shop.name, 40)}_${String(shopId)}`;
  return { shopName: shop.name, folder, files, bytes, products: p[0]?.n ?? 0, papers: a[0]?.n ?? 0, name: `medshop-files-${shop.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop'}-${new Date(Date.now() + IST).toISOString().slice(0, 10)}` };
}

/** Checks the limits before anything is logged or sent. */
export async function filesZipPlan(shopId: Types.ObjectId) {
  const info = await filesInfo(shopId);
  if (info.files > ZIP_MAX_FILES || info.bytes > ZIP_MAX_BYTES) throw AppError.conflict('Too many files for one ZIP — ask MedShop support for a full export');
  if (running.has(String(shopId))) throw busy();
  return info;
}

/** Streams every stored photo of one shop: products/, purchases/<month>/, stock/<month>/, plus index.csv. One at a time per shop; throws before the first byte if busy. */
export async function writeFilesZip(shopId: Types.ObjectId, folder: string, out: Writable) {
  if (running.has(String(shopId))) throw busy();
  running.add(String(shopId));
  try {
    const zip = new ZipWriter(out);
    const index = [csv(['path', 'kind', 'item', 'number', 'date', 'by', 'bytes'])];
    const products = ProductModel.find({ shopId, photo: { $ne: null } }).select('name photo').lean().cursor();
    for await (const p of products) {
      const data = bytesOf(p.photo?.data);
      if (!data) continue;
      const at = p.photo?.updatedAt ?? new Date();
      const path = `products/${slug(p.name)}_${String(p._id)}.webp`;
      await zip.add(`${folder}/${path}`, data, at);
      index.push(csv([path, 'Product photo', p.name, '', month(at), '', data.length]));
    }
    const [purchases, adjustments] = await Promise.all([
      PurchaseModel.find({ shopId, hasPhoto: true }).select('purchaseNumber supplierName invoiceNumber').lean(),
      AdjustmentModel.find({ shopId, hasPhoto: true }).select('adjustmentNumber type').lean(),
    ]);
    const owners = new Map<string, { dir: string; kind: string; number: string; item: string }>([
      ...purchases.map((d) => [String(d._id), { dir: 'purchases', kind: 'Supplier invoice', number: d.purchaseNumber, item: `${d.supplierName} · invoice ${d.invoiceNumber}` }] as const),
      ...adjustments.map((d) => [String(d._id), { dir: 'stock', kind: 'Stock adjustment', number: d.adjustmentNumber, item: d.type }] as const),
    ]);
    for await (const a of AttachmentModel.find({ shopId }).lean().cursor()) {
      const data = bytesOf(a.data);
      const o = owners.get(String(a.ownerId));
      if (!data || !o) continue;
      const path = `${o.dir}/${month(a.createdAt)}/${slug(o.number)}_${slug(o.item, 40)}.webp`;
      await zip.add(`${folder}/${path}`, data, a.createdAt);
      index.push(csv([path, o.kind, o.item, o.number, month(a.createdAt), a.createdByName, data.length]));
    }
    await zip.add(`${folder}/index.csv`, Buffer.from(`\uFEFF${index.join('\r\n')}\r\n`, 'utf8'));
    await zip.end();
  } finally {
    running.delete(String(shopId));
  }
}

export async function sendFilesZip(res: Response, shopId: Types.ObjectId, plan: { folder: string; name: string }) {
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${plan.name}.zip"`, 'Cache-Control': 'no-store' });
  try {
    await writeFilesZip(shopId, plan.folder, res);
  } catch (err) {
    if (!res.headersSent) throw err;
    res.destroy();
  }
}
