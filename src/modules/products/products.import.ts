import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { clientRequestId } from '../../core/zod';
import { monthEndIST } from '../../utils/date';
import { ALL_UNITS, UNITS, UNIT_TYPES, salePack as packOf, toUnits, unitsProblem, type UnitType, type Units, type UnitsInput } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { CategoryModel, categoryKey } from '../categories/category.model';
import { ShopModel } from '../shops/shop.model';
import { receiveOpening } from '../stock/stock.service';
import { refreshRollups } from '../stock/stock.ledger';
import type { Actor } from '../user/actor';
import { GST_RATES, ProductModel, SCHEDULE_TYPES } from './product.model';
import { saltKeyOf, searchKeyOf } from './products.service';

const cell = z.union([z.string().max(200), z.number()]).optional().transform((v) => (v === undefined ? '' : String(v).trim()));

const rowSchema = z
  .object({
    name: cell, company: cell, salt: cell, strength: cell, category: cell, schedule: cell, gst: cell, hsn: cell, barcode: cell,
    baseUnit: cell, saleUnit: cell, pack: cell, batch: cell, expiry: cell, quantity: cell, mrp: cell, rate: cell, rack: cell,
  })
  .strict();

export const importSchema = z
  .object({ clientRequestId, dryRun: z.boolean(), rows: z.array(rowSchema).min(1, 'The file has no rows').max(200, 'Send at most 200 rows at a time') })
  .strict();
export type ImportInput = z.infer<typeof importSchema>;
type Row = z.infer<typeof rowSchema>;

const CATEGORY_BY_BASE: Record<string, string> = { TABLET: 'Tablet', CAPSULE: 'Capsule', BOTTLE: 'Syrup', VIAL: 'Injection', TUBE: 'Ointment', GM: 'Ayurvedic' };
const MAX_PAISE = 10_000_000;
const MAX_QTY = 10_000_000;

/** "12/26", "12/2026", "12-2026" or "2026-12" → month end IST. */
function parseExpiry(v: string): Date | null {
  let m = /^(\d{1,2})[/-](\d{2}|\d{4})$/.exec(v);
  if (m) {
    const month = Number(m[1]);
    const year = m[2]?.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    return month >= 1 && month <= 12 ? monthEndIST(year, month) : null;
  }
  m = /^(\d{4})-(\d{1,2})$/.exec(v);
  if (m) {
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? monthEndIST(Number(m[1]), month) : null;
  }
  return null;
}

/** "30", "30.5", "₹1,234.50" → paise. */
function rupees(v: string): number | null {
  const [whole = '', frac = '', extra] = v.replace(/[₹,\s]/g, '').split('.');
  if (extra !== undefined || !/^\d+$/.test(whole) || !/^\d{0,2}$/.test(frac)) return null;
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

const unitTypeOf = (u: string): UnitType | undefined => UNIT_TYPES.find((t) => UNITS[t].includes(u));

interface Plan {
  row: number;
  name: string;
  product: 'existing' | 'new';
  productId?: Types.ObjectId;
  draft?: Record<string, unknown>;
  stock: { batchNumber: string; expiry: Date; quantity: number; mrp: number; purchaseRate: number; rack: string };
  quantityLabel: string;
  errors: string[];
  warnings: string[];
}

async function plan(t: TenantContext, rows: Row[], session?: ClientSession): Promise<Plan[]> {
  const shop = await ShopModel.findById(t.shopId).select('settings.tax.defaultGstRate').lean();
  const defaultGst = shop?.settings.tax?.defaultGstRate ?? 12;
  const cats = await CategoryModel.find({ shopId: t.shopId }).select('name key').lean();
  const catByKey = new Map(cats.map((c) => [c.key, c]));
  const names = [...new Set(rows.map((r) => r.name.toLowerCase()).filter(Boolean))];
  const existing = await ProductModel.find({ shopId: t.shopId, nameLower: { $in: names } }).select('name nameLower units isActive').session(session ?? null).lean();
  const byName = new Map(existing.map((p) => [p.nameLower, p]));
  const codes = rows.filter((r) => r.barcode && !byName.has(r.name.toLowerCase())).map((r) => r.barcode);
  const takenCodes = new Set((await ProductModel.find({ shopId: t.shopId, barcode: { $in: codes } }).select('barcode').session(session ?? null).lean()).map((p) => p.barcode));
  const newUnits = new Map<string, string>();

  return rows.map((r, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!r.name) errors.push('Product name is missing');
    const known = byName.get(r.name.toLowerCase());
    if (known && !known.isActive) errors.push(`${known.name} is deactivated`);

    let units: UnitsInput | null = null;
    let draft: Record<string, unknown> | undefined;
    if (!known && r.name) {
      const sale = r.saleUnit.toUpperCase() || 'PIECE';
      const pack = r.pack ? Number(r.pack) : 1;
      const base = r.baseUnit.toUpperCase() || (pack === 1 ? sale : '');
      if (!r.saleUnit && !r.baseUnit) warnings.push('New product sold as single PIECE — check its units after import');
      if (!Number.isInteger(pack) || pack < 1) errors.push('Units per sale unit must be a whole number');
      else if (!base) errors.push('Base unit is needed when one sale unit holds more than one (e.g. TABLET)');
      else if (!ALL_UNITS.includes(sale) || !ALL_UNITS.includes(base)) errors.push(`Unknown unit — use one of ${ALL_UNITS.join(', ')}`);
      else {
        const type = unitTypeOf(base) ?? 'COUNT';
        units = { type, base, sale, salePack: pack, purchase: sale, purchasePack: 1, allowLooseSale: base !== sale };
        const problem = unitsProblem(units);
        if (problem) errors.push(problem);
      }
      const catName = r.category || CATEGORY_BY_BASE[base] || 'FMCG';
      const cat = catByKey.get(categoryKey(catName));
      if (!cat) errors.push(`Category “${r.category}” doesn’t exist — add it in Settings or leave it blank`);
      const schedule = (r.schedule.toUpperCase().replace(/^SCHEDULE\s*/, '').replace(/[\s-]/g, '_') || 'OTC') as (typeof SCHEDULE_TYPES)[number];
      if (!SCHEDULE_TYPES.includes(schedule)) errors.push('Schedule is OTC, H, H1, X or NON_DRUG');
      const gst = r.gst ? Number(r.gst.replace('%', '')) : defaultGst;
      if (!(GST_RATES as readonly number[]).includes(gst)) errors.push('GST must be 0, 5, 12, 18 or 28');
      if (r.hsn && !/^\d{4,8}$/.test(r.hsn)) errors.push('HSN has 4 to 8 digits');
      if (r.barcode && !/^[A-Za-z0-9-]{4,32}$/.test(r.barcode)) errors.push('Barcode has 4 to 32 letters or digits');
      if (r.barcode && takenCodes.has(r.barcode)) errors.push('Another product already has this barcode');
      const sig = units ? `${units.base}/${units.sale}/${units.salePack}` : '';
      const first = newUnits.get(r.name.toLowerCase());
      if (first === undefined) newUnits.set(r.name.toLowerCase(), sig);
      else if (first !== sig) warnings.push('Units differ from an earlier row of this product — the first row’s units are used');
      if (units && cat) {
        const input = { name: r.name, salt: r.salt, company: r.company };
        draft = {
          name: r.name, nameLower: r.name.toLowerCase(), searchKey: searchKeyOf(input), company: r.company, salt: r.salt, saltKey: saltKeyOf(r.salt, r.strength),
          strength: r.strength, categoryId: cat._id, scheduleType: schedule, storageType: 'NORMAL', hsnCode: r.hsn, gstRate: gst, barcode: r.barcode || undefined,
          units: toUnits(units), packSize: '', defaultRack: r.rack.toUpperCase(), reorderLevel: 0, reorderQuantity: 0,
        };
      }
    }

    const salePack = known ? packOf(known.units as Units) : (units?.salePack ?? 1);
    const saleName = known ? (known.units as Units).sale : (units?.sale ?? 'PIECE');
    if (!r.batch) errors.push('Batch number is missing');
    else if (!/^[A-Za-z0-9/-]{1,20}$/.test(r.batch)) errors.push('Batch number: letters, numbers, / and - only');
    const expiry = parseExpiry(r.expiry);
    if (!expiry) errors.push('Expiry should look like 12/26 or 12/2026');
    else if (expiry.getTime() < Date.now()) warnings.push('Already expired — it will not sell');
    const qty = Number(r.quantity);
    if (!r.quantity || !Number.isInteger(qty) || qty < 1) errors.push('Quantity must be a whole number of ' + saleName);
    const mrp = rupees(r.mrp);
    if (mrp === null || mrp < 1 || mrp > MAX_PAISE) errors.push('MRP should be a price like 30.00');
    const rate = rupees(r.rate);
    if (rate === null || rate > MAX_PAISE) errors.push('Purchase rate should be a price like 21.00');
    if (r.rack && !/^[A-Za-z0-9][A-Za-z0-9-]{0,11}$/.test(r.rack)) errors.push('Rack: letters, numbers and dashes, like A-2-1');
    const quantity = qty * salePack;
    if (quantity > MAX_QTY) errors.push('Quantity is too large');

    return {
      row: i + 1,
      name: r.name,
      product: known ? 'existing' : 'new',
      productId: known?._id,
      draft,
      stock: { batchNumber: r.batch, expiry: expiry ?? new Date(0), quantity, mrp: mrp ?? 0, purchaseRate: rate ?? 0, rack: r.rack.toUpperCase() },
      quantityLabel: `${String(qty)} ${saleName}`,
      errors,
      warnings,
    };
  });
}

const view = (p: Plan[]) => ({
  rows: p.map(({ row, name, product, quantityLabel, errors, warnings, stock }) => ({ row, name, product, batch: stock.batchNumber, quantity: quantityLabel, errors, warnings })),
  summary: {
    rows: p.length,
    errors: p.filter((x) => x.errors.length).length,
    newProducts: new Set(p.filter((x) => x.product === 'new').map((x) => x.name.toLowerCase())).size,
  },
});

export async function importRows(t: TenantContext, actor: Actor, input: ImportInput, ip?: string) {
  const preview = await plan(t, input.rows);
  if (input.dryRun) return { ...view(preview), saved: false };
  if (preview.some((p) => p.errors.length)) throw AppError.validation('Fix the rows with errors first', view(preview).rows.filter((r) => r.errors.length));

  const { result } = await once(t.shopId, 'import', input.clientRequestId, async (session) => {
    const rows = await plan(t, input.rows, session);
    const now = new Date();
    const created = new Map<string, Types.ObjectId>();
    const touched = new Set<string>();
    let merged = 0;
    for (const r of rows) {
      const key = r.name.toLowerCase();
      let productId = r.productId ?? created.get(key);
      if (!productId && r.draft) {
        const [p] = await ProductModel.create([{ shopId: t.shopId, ...r.draft, createdBy: new Types.ObjectId(actor.id), createdByName: actor.name }], { session }).catch((err: unknown) => {
          if ((err as { code?: number }).code === 11000) throw AppError.validation(`Row ${String(r.row)}: another product already has this name or barcode`);
          throw err;
        });
        if (!p) throw AppError.internal();
        productId = p._id;
        created.set(key, productId);
      }
      if (!productId) throw AppError.internal();
      const p = await ProductModel.findOne({ shopId: t.shopId, _id: productId }).select('name units storageType defaultRack').session(session).lean();
      if (!p) throw AppError.internal();
      const out = await receiveOpening(t.shopId, p, { ...r.stock, mrpChoice: 'separate' }, actor, session, now);
      if (out.how === 'merged') merged++;
      touched.add(String(productId));
    }
    await refreshRollups(t.shopId, [...touched].map((id) => new Types.ObjectId(id)), session, now);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'stock', entityName: 'Excel import', text: `${actor.name} imported ${rows.length} stock rows (${created.size} new products)`, ip }, session);
    return { rows: rows.length, newProducts: created.size, merged };
  });
  return { ...view(preview), saved: true, result };
}

