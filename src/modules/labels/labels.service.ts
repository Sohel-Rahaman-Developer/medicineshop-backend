import PDFDocument from 'pdfkit';
import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { BOLD, FONT, rupees } from '../../core/export';
import type { TenantContext } from '../../core/middleware/tenant';
import { salePack, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { CounterModel } from '../counters/counter.model';
import { ProductModel } from '../products/product.model';
import { PurchaseModel } from '../purchases/purchase.model';
import { ShopModel } from '../shops/shop.model';
import { BatchModel } from '../stock/batch.model';
import { fefo, type BatchLike } from '../stock/stock.domain';
import type { Actor } from '../user/actor';
import { barsOf, inStoreCode } from './barcode';

// Sizes in mm. Sheets are the common A4 sticker sheets; rolls are one label per page for label printers.
interface Layout { cols: number; rows: number; w: number; h: number; top: number; left: number; pitchX: number; pitchY: number; roll: boolean; name: number; small: number; pad: number }
export const LAYOUTS = {
  'a4-65': { cols: 5, rows: 13, w: 38.1, h: 21.2, top: 10.7, left: 4.75, pitchX: 40.6, pitchY: 21.2, roll: false, name: 6.2, small: 5.3, pad: 1.1 },
  'a4-24': { cols: 3, rows: 8, w: 63.5, h: 33.9, top: 12.9, left: 7.25, pitchX: 66, pitchY: 33.9, roll: false, name: 8.5, small: 7, pad: 1.8 },
  'roll-50x25': { cols: 1, rows: 1, w: 50, h: 25, top: 0, left: 0, pitchX: 50, pitchY: 25, roll: true, name: 7.6, small: 6.3, pad: 1.5 },
  'roll-38x25': { cols: 1, rows: 1, w: 38, h: 25, top: 0, left: 0, pitchX: 38, pitchY: 25, roll: true, name: 6.8, small: 5.7, pad: 1.3 },
} as const satisfies Record<string, Layout>;
export type LayoutKey = keyof typeof LAYOUTS;
export const LAYOUT_KEYS = Object.keys(LAYOUTS) as [LayoutKey, ...LayoutKey[]];

export const MAX_LABELS = 2000;
const pt = (mm: number) => (mm * 72) / 25.4;

interface ProductLean { _id: Types.ObjectId; name: string; strength?: string; barcode?: string | null; units: Units }
type BatchLean = BatchLike & { _id: Types.ObjectId; productId: Types.ObjectId; batchNumber: string };

const PRODUCT_FIELDS = 'name strength barcode units';
const BATCH_FIELDS = 'productId batchNumber expiryDate mrp quantity status receivedAt costPerBaseUnit';

async function batchesFor(t: TenantContext, ids: Types.ObjectId[], also: Types.ObjectId[] = []) {
  const all = await BatchModel.find({ shopId: t.shopId, productId: { $in: ids }, $or: [{ quantity: { $gt: 0 }, status: 'active' }, { _id: { $in: also } }] }).select(BATCH_FIELDS).lean<BatchLean[]>();
  const now = new Date();
  const by = new Map<string, BatchLean[]>();
  for (const b of all) by.set(String(b.productId), [...(by.get(String(b.productId)) ?? []), b]);
  // Sellable first, the next to sell on top; a batch named by the purchase stays even when it isn't sellable now.
  for (const [k, list] of by) {
    const order = fefo(list, now);
    by.set(k, [...order, ...list.filter((b) => !order.includes(b))]);
  }
  return by;
}

const rowOf = (p: ProductLean, batches: BatchLean[], batchId: string | null, copies: number, key: string) => {
  const pack = salePack(p.units);
  return {
    key,
    productId: String(p._id),
    name: p.name,
    strength: p.strength ?? '',
    unit: p.units.sale,
    barcode: p.barcode || null,
    bars: p.barcode ? barsOf(p.barcode) : null,
    batches: batches.map((b) => ({ id: String(b._id), batchNumber: b.batchNumber, expiryDate: b.expiryDate, mrp: b.mrp, quantity: Math.floor(b.quantity / pack) })),
    batchId: batchId ?? (batches[0] ? String(batches[0]._id) : null),
    copies,
  };
};
export type LabelRow = ReturnType<typeof rowOf>;

/** What to print: the products asked for (one label each), or a purchase's lines (one label per strip / bottle received). */
export async function items(t: TenantContext, q: { ids?: string[]; purchase?: string }): Promise<LabelRow[]> {
  if (q.purchase) {
    const pur = await PurchaseModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(q.purchase) }).select('lines').lean();
    if (!pur) throw AppError.notFound('Purchase not found');
    const ids = [...new Set(pur.lines.map((l) => String(l.productId)))].map((id) => new Types.ObjectId(id));
    const [products, batches] = await Promise.all([ProductModel.find({ shopId: t.shopId, _id: { $in: ids } }).select(PRODUCT_FIELDS).lean<ProductLean[]>(), batchesFor(t, ids, pur.lines.map((l) => l.batchId))]);
    const byId = new Map(products.map((p) => [String(p._id), p]));
    return pur.lines.flatMap((l, i) => {
      const p = byId.get(String(l.productId));
      if (!p) return [];
      // quantityInBase already holds the free goods.
      const copies = Math.max(1, Math.floor(l.quantityInBase / salePack(p.units)));
      return [rowOf(p, batches.get(String(p._id)) ?? [], String(l.batchId), Math.min(copies, 500), `${String(i)}-${String(p._id)}`)];
    });
  }
  const ids = (q.ids ?? []).map((id) => new Types.ObjectId(id));
  const [products, batches] = await Promise.all([ProductModel.find({ shopId: t.shopId, _id: { $in: ids } }).select(PRODUCT_FIELDS).lean<ProductLean[]>(), batchesFor(t, ids)]);
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return ids.flatMap((id) => {
    const p = byId.get(String(id));
    return p ? [rowOf(p, batches.get(String(id)) ?? [], null, 1, String(id))] : [];
  });
}

/**
 * The shop's own barcode for products that have none — only when the person asks. In-store EAN-13 (29…), the next
 * number of the shop's own series; a number someone already typed on another product is skipped.
 */
export async function giveBarcodes(t: TenantContext, actor: Actor, productIds: string[], ip?: string) {
  const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: productIds.map((id) => new Types.ObjectId(id)) } }).select('name barcode').lean<{ _id: Types.ObjectId; name: string; barcode?: string | null }[]>();
  const out: { productId: string; barcode: string; bars: ReturnType<typeof barsOf> }[] = [];
  for (const p of products) {
    if (p.barcode) continue;
    for (let tries = 0; tries < 20; tries++) {
      const doc = await CounterModel.findOneAndUpdate({ _id: `${String(t.shopId)}:labelCode`, shopId: t.shopId }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
      const code = inStoreCode(doc.seq);
      const taken = await ProductModel.exists({ shopId: t.shopId, $or: [{ barcode: code }, { altBarcodes: code }] });
      if (taken) continue;
      const set = await ProductModel.updateOne({ shopId: t.shopId, _id: p._id, $or: [{ barcode: { $exists: false } }, { barcode: null }, { barcode: '' }] }, { $set: { barcode: code } }).catch((e: unknown) => {
        if ((e as { code?: number }).code === 11000) return null;
        throw e;
      });
      if (!set) continue;
      if (set.modifiedCount) {
        out.push({ productId: String(p._id), barcode: code, bars: barsOf(code) });
        await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'products', entityId: String(p._id), entityName: p.name, text: `${actor.name} gave ${p.name} the shop's own barcode ${code}`, ip });
      }
      break;
    }
  }
  return out;
}

export interface PdfInput {
  layout: LayoutKey;
  skip: number;
  show: { mrp: boolean; batch: boolean; shop: boolean };
  items: { productId: string; batchId?: string | null; copies: number }[];
}

interface Label { name: string; code: string; bars: ReturnType<typeof barsOf>; mrp: string | null; batch: string | null }

const expiry = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;

/** One line that fits, cut with … when it doesn't. */
function fit(doc: PDFKit.PDFDocument, text: string, width: number) {
  if (doc.widthOfString(text) <= width) return text;
  let s = text;
  while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function draw(doc: PDFKit.PDFDocument, x: number, y: number, l: Layout, label: Label, shop: string | null) {
  const w = pt(l.w);
  const h = pt(l.h);
  const pad = pt(l.pad);
  const inner = w - 2 * pad;
  let at = y + pad;
  const line = (text: string, font: 'r' | 'b', size: number, color = '#000') => {
    doc.font(font).fontSize(size).fillColor(color);
    doc.text(fit(doc, text, inner), x + pad, at, { lineBreak: false, width: inner });
    at += size * 1.18;
  };
  if (shop) line(shop, 'r', l.small * 0.9, '#444');
  line(label.name, 'b', l.name);
  if (label.mrp) line(label.mrp, 'b', l.small);
  if (label.batch) line(label.batch, 'r', l.small * 0.92, '#222');
  // The bars take what is left above the digits; at most 0.33 mm a module (100%), never wider than the label.
  const digits = l.small * 1.1;
  const barTop = at + pt(0.4);
  const barH = Math.max(pt(3.5), y + h - pad - digits - pt(0.2) - barTop);
  const modules = label.bars.bars.length + 2 * label.bars.quiet;
  const mw = Math.min(pt(0.33), (w - pt(0.6)) / modules);
  const left = x + (w - label.bars.bars.length * mw) / 2;
  const bars = label.bars.bars;
  doc.fillColor('#000');
  for (let i = 0; i < bars.length; ) {
    if (bars[i] !== '1') {
      i++;
      continue;
    }
    let j = i;
    while (bars[j] === '1') j++;
    doc.rect(left + i * mw, barTop, (j - i) * mw, barH).fill();
    i = j;
  }
  doc.font('r').fontSize(l.small).fillColor('#000');
  doc.text(label.code, x, barTop + barH + pt(0.2), { lineBreak: false, width: w, align: 'center' });
}

/** The labels as a PDF to print at 100% (no "fit to page"): sheets fill from `skip`, so a half-used sheet goes back in. */
export async function pdf(t: TenantContext, input: PdfInput): Promise<Buffer> {
  const l: Layout = LAYOUTS[input.layout];
  const per = l.cols * l.rows;
  if (!l.roll && input.skip >= per) throw AppError.validation(`A sheet has ${String(per)} labels`);
  const total = input.items.reduce((s, i) => s + i.copies, 0);
  if (total > MAX_LABELS) throw AppError.validation(`At most ${String(MAX_LABELS)} labels at a time`);
  const ids = [...new Set(input.items.map((i) => i.productId))].map((id) => new Types.ObjectId(id));
  const [products, batches, shop] = await Promise.all([
    ProductModel.find({ shopId: t.shopId, _id: { $in: ids } }).select(PRODUCT_FIELDS).lean<ProductLean[]>(),
    batchesFor(t, ids, input.items.flatMap((i) => (i.batchId ? [new Types.ObjectId(i.batchId)] : []))),
    input.show.shop ? ShopModel.findById(t.shopId).select('name').lean() : null,
  ]);
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const labels: Label[] = [];
  for (const it of input.items) {
    const p = byId.get(it.productId);
    if (!p) throw AppError.notFound('Product not found');
    if (!p.barcode) throw AppError.validation(`${p.name} has no barcode yet — give it one first`);
    const list = batches.get(it.productId) ?? [];
    const b = it.batchId ? list.find((x) => String(x._id) === it.batchId) : list[0];
    if (it.batchId && !b) throw AppError.validation(`That batch is not ${p.name}’s`);
    const label: Label = {
      name: [p.name, p.strength].filter(Boolean).join(' '),
      code: p.barcode,
      bars: barsOf(p.barcode),
      mrp: input.show.mrp && b ? `MRP ${rupees(b.mrp)}/${p.units.sale.toLowerCase()}` : null,
      batch: input.show.batch && b ? `B.No ${b.batchNumber} · Exp ${expiry(b.expiryDate)}` : null,
    };
    for (let c = 0; c < it.copies; c++) labels.push(label);
  }

  const size: [number, number] | 'A4' = l.roll ? [pt(l.w), pt(l.h)] : 'A4';
  const doc = new PDFDocument({ size, margin: 0, autoFirstPage: false, info: { Title: 'Barcode labels', Producer: 'MedBox24' } });
  doc.registerFont('r', FONT);
  doc.registerFont('b', BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => { resolve(Buffer.concat(chunks)); }));
  const shopName = shop?.name ?? null;
  labels.forEach((label, i) => {
    if (l.roll) {
      doc.addPage({ size, margin: 0 });
      draw(doc, 0, 0, l, label, shopName);
      return;
    }
    const slot = input.skip + i;
    if (i === 0 || slot % per === 0) doc.addPage({ size, margin: 0 });
    const n = slot % per;
    draw(doc, pt(l.left + (n % l.cols) * l.pitchX), pt(l.top + Math.floor(n / l.cols) * l.pitchY), l, label, shopName);
  });
  doc.end();
  return done;
}
