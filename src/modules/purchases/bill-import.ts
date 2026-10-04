import { Schema, Types, model, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { tenantScoped } from '../../core/tenant-scope';
import { once } from '../../core/idempotency';
import { clientRequestId, istDay, monthEnd, objectId, paise } from '../../core/zod';
import type { Actor } from '../user/actor';
import { insertProduct, prepareProduct } from '../products/products.service';
import { createProductSchema } from '../products/products.validation';
import { readBillFile, readRows } from './bill-read';
import { savePurchase } from './purchases.service';
import { purchaseLineObject, type PurchaseInput } from './purchases.validation';
import { inr } from '../../utils/money';
import { readPack } from '../../utils/units';
import { ProductModel } from '../products/product.model';
import { BatchModel } from '../stock/batch.model';
import { SupplierModel } from '../suppliers/supplier.model';

/** What a supplier calls a product on its bill → the shop's product. Learnt when the shop confirms a line (D77). */
const aliasSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    key: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  },
  { timestamps: true, versionKey: false },
);
aliasSchema.index({ shopId: 1, supplierId: 1, key: 1 }, { unique: true });
aliasSchema.plugin(tenantScoped);
export const BillAliasModel = model('BillAlias', aliasSchema);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/(^|\s)\.|\.(\s|$)/g, ' ').trim();
// Form words say nothing about which product it is: "PAN 40 TAB" and "Pan 40 Tablet" are the same.
const FORM = new Set(['tab', 'tabs', 'tablet', 'tablets', 't', 'cap', 'caps', 'capsule', 'capsules', 'syp', 'syrup', 'susp', 'suspension', 'inj', 'injection', 'oint', 'ointment', 'cream', 'gel', 'drop', 'drops', 'soap', 'oil', 'lotion', 'mg', 'ml', 'gm', 'g', 'mcg', 'strip', 'bottle']);
const coreOf = (name: string) => norm(name).split(' ').filter((w) => w && !FORM.has(w) && !/^\d/.test(w));
const numsOf = (name: string) => (norm(name).match(/\d+\.\d+|\d+/g) ?? []).map(Number);
export const aliasKey = (name: string, pack: string) => `${norm(name)}|${norm(pack)}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 1 = same words and numbers, 0 = nothing alike. Numbers (strength) must agree or it is a different medicine. */
function likeness(line: string, product: { name: string; strength: string }) {
  const a = coreOf(line);
  const b = coreOf(product.name);
  if (!a.length || !b.length) return 0;
  // A short form on the bill ("AZI" for Azikem) counts as the same word.
  const shared = a.filter((w) => b.some((x) => x === w || (Math.min(w.length, x.length) >= 3 && (x.startsWith(w) || w.startsWith(x))))).length;
  const words = shared / new Set([...a, ...b]).size;
  const na = numsOf(line);
  const nb = [...numsOf(product.name), ...numsOf(product.strength)];
  // A strength in the product name must be on the bill too: Pan 40 is not Pan 20.
  if (na.some((n) => !nb.includes(n)) || numsOf(product.name).some((n) => !na.includes(n))) return words * 0.4;
  return words;
}

export const billLineSchema = z
  .object({
    name: z.string().trim().min(1, 'Product name is missing').max(120),
    company: z.string().trim().max(80).default(''),
    pack: z.string().trim().max(40).default(''),
    batchNumber: z.string().trim().toUpperCase().max(20).default(''),
    expiry: monthEnd.optional(),
    /** Paise per sale unit. */
    mrp: paise('MRP').min(1, 'MRP is required'),
    /** The bill's previous MRP column, when it has one. */
    oldMrp: paise('Old MRP').optional(),
    rate: paise('Rate').default(0),
    quantity: z.number().int().min(1).max(1_000_000),
    freeQuantity: z.number().int().min(0).max(1_000_000).default(0),
    discountPercent: z.number().min(0).max(100).default(0),
    gstRate: z.number().min(0).max(40).optional(),
    hsn: z.string().trim().max(8).default(''),
  })
  .strict();
export const billPreviewSchema = z.object({ supplierId: objectId, lines: z.array(billLineSchema).min(1, 'The bill has no lines').max(300, 'At most 300 lines in one bill') }).strict();
export type BillLine = z.infer<typeof billLineSchema>;
export type BillPreviewInput = z.infer<typeof billPreviewSchema>;

/** same = stock goes up in a batch already on the shelf; newBatch = new batch of a known product; mrp = price differs; new = product not in the shop; check = pick from suggestions. */
export type LineStatus = 'same' | 'newBatch' | 'mrp' | 'new' | 'check';

const SURE = 0.99;
const SUGGEST = 0.34;

/** Every bill line with what saving it would do — nothing is written. */
export async function previewBill(t: TenantContext, input: BillPreviewInput) {
  const supplierId = new Types.ObjectId(input.supplierId);
  if (!(await SupplierModel.exists({ shopId: t.shopId, _id: supplierId }))) throw AppError.notFound('Supplier not found');
  const aliases = await BillAliasModel.find({ shopId: t.shopId, supplierId, key: { $in: input.lines.map((l) => aliasKey(l.name, l.pack)) } }).lean();
  const byKey = new Map(aliases.map((a) => [a.key, a.productId]));
  const out = [];
  for (const [i, line] of input.lines.entries()) out.push({ index: i, ...(await previewLine(t, line, byKey.get(aliasKey(line.name, line.pack)))) });
  return { lines: out, counts: countOf(out.map((l) => l.status)) };
}

const countOf = (s: LineStatus[]) => ({ same: s.filter((x) => x === 'same').length, newBatch: s.filter((x) => x === 'newBatch').length, mrp: s.filter((x) => x === 'mrp').length, new: s.filter((x) => x === 'new').length, check: s.filter((x) => x === 'check').length });

const PRODUCT_FIELDS = 'name company strength packSize units defaultRack lastMrp noExpiry scheduleType gstRate isActive';

async function previewLine(t: TenantContext, line: BillLine, aliasId?: Types.ObjectId) {
  const notes: string[] = [];
  let product = aliasId ? await ProductModel.findOne({ shopId: t.shopId, _id: aliasId, isActive: true }).select(PRODUCT_FIELDS).lean() : null;
  let matchedBy: 'alias' | 'name' | null = product ? 'alias' : null;
  let suggestions: { id: string; name: string; company: string; score: number }[] = [];
  if (!product) {
    const core = coreOf(line.name);
    const pool = core.length ? await ProductModel.find({ shopId: t.shopId, isActive: true, searchKey: { $regex: `(^| )${escape(core[0] ?? '')}` } }).select(PRODUCT_FIELDS).limit(40).lean() : [];
    const company = norm(line.company);
    const scored = pool
      .map((p) => ({ p, score: likeness(line.name, p) + (company && norm(p.company).startsWith(company.split(' ')[0] ?? '') ? 0.01 : 0) }))
      .filter((x) => x.score >= SUGGEST)
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    const second = scored[1];
    if (top && top.score >= SURE && (!second || second.score < SURE)) {
      product = top.p;
      matchedBy = 'name';
    } else suggestions = scored.slice(0, 3).map((x) => ({ id: String(x.p._id), name: x.p.name, company: x.p.company, score: Math.round(Math.min(x.score, 1) * 100) / 100 }));
  }
  if (line.oldMrp && line.oldMrp !== line.mrp) notes.push(`The bill shows the old MRP ${inr(line.oldMrp)} → ${inr(line.mrp)}`);

  if (!product) {
    const packRead = readPack(line.pack);
    return { status: (suggestions.length ? 'check' : 'new') as LineStatus, productId: null, matchedBy, product: null, batch: null, suggestions, packRead, notes };
  }

  let status: LineStatus = 'newBatch';
  let batch: { id: string; batchNumber: string; quantity: number; mrp: number; expiryDate: Date } | null = null;
  if (line.batchNumber) {
    const found = await BatchModel.find({ shopId: t.shopId, productId: product._id, batchNumberUpper: line.batchNumber, status: { $ne: 'returned' } }).select('batchNumber quantity mrp expiryDate').lean();
    const same = found.find((b) => !line.expiry || b.expiryDate.getTime() === line.expiry.getTime());
    if (same) {
      batch = { id: String(same._id), batchNumber: same.batchNumber, quantity: same.quantity, mrp: same.mrp, expiryDate: same.expiryDate };
      if (same.mrp === line.mrp) status = 'same';
      else {
        status = 'mrp';
        notes.push(`Batch ${same.batchNumber} is on the shelf at MRP ${inr(same.mrp)}, the bill says ${inr(line.mrp)} — it goes in as a separate batch`);
      }
    } else if (found.length) notes.push(`Batch ${line.batchNumber} is on the shelf with another expiry — this one goes in separately`);
  }
  if (status === 'newBatch' && product.lastMrp != null && product.lastMrp !== line.mrp) {
    status = 'mrp';
    notes.push(`Last MRP was ${inr(product.lastMrp)}, now ${inr(line.mrp)}`);
  }
  return {
    status,
    productId: String(product._id),
    matchedBy,
    product: { id: String(product._id), name: product.name, company: product.company, packSize: product.packSize, units: product.units, defaultRack: product.defaultRack, noExpiry: product.noExpiry, scheduleType: product.scheduleType, gstRate: product.gstRate },
    batch,
    suggestions,
    packRead: null,
    notes,
  };
}

/** The shop confirmed these lines: next time the same supplier name finds the same product at once. */
export async function rememberAliases(shopId: Types.ObjectId, supplierId: Types.ObjectId, pairs: { name: string; pack: string; productId: Types.ObjectId }[], session?: ClientSession) {
  if (!pairs.length) return;
  await BillAliasModel.bulkWrite(
    pairs.map((p) => ({ updateOne: { filter: { shopId, supplierId, key: aliasKey(p.name, p.pack) }, update: { $set: { productId: p.productId } }, upsert: true } })),
    { session },
  );
}

/** One confirmed bill line: an existing product, or a new one made from the bill — never both. */
const importLineSchema = purchaseLineObject
  .extend({
    productId: objectId.optional(),
    newProduct: createProductSchema.omit({ stock: true }).optional(),
    /** The bill's own name and pack, remembered for this supplier. */
    billName: z.string().trim().max(120).default(''),
    billPack: z.string().trim().max(40).default(''),
  })
  .refine((v) => Boolean(v.productId) !== Boolean(v.newProduct), { message: 'Pick a product or add it as new', path: ['productId'] })
  .refine((v) => !v.mfg || !v.expiry || v.mfg <= v.expiry, { message: 'Made after it expires?', path: ['mfg'] });

export const billImportSchema = z
  .object({
    clientRequestId,
    supplierId: objectId,
    invoiceNumber: z.string().trim().min(1, 'Invoice number is required').max(40),
    invoiceDate: istDay,
    dueDate: istDay.optional(),
    lines: z.array(importLineSchema).min(1, 'The bill has no lines').max(300, 'At most 300 lines in one purchase'),
    notes: z.string().trim().max(500).default(''),
  })
  .strict()
  .refine((v) => v.invoiceDate.getTime() <= Date.now() + 24 * 60 * 60 * 1000, { message: 'Invoice date is in the future', path: ['invoiceDate'] });
export type BillImportInput = z.infer<typeof billImportSchema>;

/** Confirm & Save: new products, then the purchase as if typed by hand, then the names to remember — all or nothing. */
export async function importBill(t: TenantContext, actor: Actor, input: BillImportInput, ip?: string) {
  for (const l of input.lines) if (l.newProduct) await prepareProduct(t, l.newProduct);
  return once(t.shopId, 'purchase', input.clientRequestId, async (session) => {
    const made = new Map<string, Types.ObjectId>();
    const productIds: string[] = [];
    for (const [i, l] of input.lines.entries()) {
      if (l.productId) {
        productIds.push(l.productId);
        continue;
      }
      const np = l.newProduct;
      if (!np) throw AppError.internal();
      const key = np.name.toLowerCase();
      let id = made.get(key);
      if (!id) {
        const p = await insertProduct(t, actor, np, null, session, ip).catch((err: unknown) => {
          if (err instanceof AppError && err.code === 'VALIDATION_ERROR') throw AppError.validation(`Line ${String(i + 1)}: ${err.message}`, [{ field: `body.lines.${String(i)}.newProduct.name`, message: err.message }]);
          throw err;
        });
        id = p._id;
        made.set(key, id);
      }
      productIds.push(String(id));
    }
    const purchase: PurchaseInput = {
      clientRequestId: input.clientRequestId,
      supplierId: input.supplierId,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      lines: input.lines.map(({ newProduct: _np, billName: _bn, billPack: _bp, ...l }, i) => ({ ...l, productId: productIds[i] ?? '' })),
      payment: { mode: 'CREDIT', amount: 0, fromDrawer: true, reference: '' },
      notes: input.notes,
    };
    const out = await savePurchase(t, actor, purchase, session, ip);
    await rememberAliases(
      t.shopId,
      new Types.ObjectId(input.supplierId),
      input.lines.flatMap((l, i) => (l.billName ? [{ name: l.billName, pack: l.billPack, productId: new Types.ObjectId(productIds[i]) }] : [])),
      session,
    );
    return { ...out, newProducts: made.size };
  });
}

export const billReadSchema = z
  .object({
    supplierId: objectId,
    fileName: z.string().trim().min(1).max(200),
    /** The file, base64 — a Word or PDF bill. */
    data: z.string().max(1_100_000, 'That file is too large — at most about 800 KB').optional(),
    /** Or the rows of an Excel / CSV sheet, read in the browser. */
    rows: z.array(z.array(z.string().max(200)).max(40)).max(400, 'At most 400 rows').optional(),
  })
  .strict()
  .refine((v) => Boolean(v.data) !== Boolean(v.rows), { message: 'Send the file or its rows', path: ['data'] });
export type BillReadInput = z.infer<typeof billReadSchema>;

/** Upload → the bill's lines, each with what saving it would do. Lines the reader can't use are listed, not dropped silently. */
export async function readAndPreview(t: TenantContext, input: BillReadInput) {
  const read = input.rows ? readRows(input.rows) : readBillFile(input.fileName, Buffer.from((input.data ?? '').replace(/^data:[^,]*,/, ''), 'base64'));
  const usable: { read: (typeof read.lines)[number]; line: BillLine }[] = [];
  const skipped = [...read.skipped];
  for (const r of read.lines) {
    const ok = billLineSchema.safeParse({ name: r.name, company: r.company, pack: r.pack, batchNumber: r.batchNumber, expiry: r.expiry, mrp: r.mrp, oldMrp: r.oldMrp, rate: r.rate, quantity: r.quantity, freeQuantity: r.freeQuantity, discountPercent: r.discountPercent, gstRate: r.gstRate, hsn: r.hsn });
    if (ok.success) usable.push({ read: r, line: ok.data });
    else skipped.push(`${r.name} — ${ok.error.issues[0]?.message ?? 'not readable'}`);
  }
  if (!usable.length) throw AppError.validation('No item lines could be read from this bill', [{ field: 'body.data', message: skipped.slice(0, 3).join(' | ') || 'No lines' }]);
  const preview = await previewBill(t, { supplierId: input.supplierId, lines: usable.map((u) => u.line) });
  return {
    meta: read.meta,
    billCheck: read.billCheck,
    header: read.header,
    skipped,
    counts: preview.counts,
    lines: usable.map((u, i) => ({ ...u.read, ...preview.lines[i] })),
  };
}
