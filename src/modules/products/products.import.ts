import writeXlsxFile from 'write-excel-file/node';
import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { clientRequestId } from '../../core/zod';
import { istYmd, monthEndIST } from '../../utils/date';
import { ALL_UNITS, UNITS, UNIT_TYPES, salePack as packOf, toUnits, unitsProblem, type UnitType, type Units, type UnitsInput } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { CategoryModel, categoryKey } from '../categories/category.model';
import { ShopModel } from '../shops/shop.model';
import { lotOf } from '../stock/stock.domain';
import { receiveOpening } from '../stock/stock.service';
import { refreshRollups } from '../stock/stock.ledger';
import type { Actor } from '../user/actor';
import { GST_RATES, ProductModel, SCHEDULE_TYPES } from './product.model';
import { saltKeyOf, searchKeyOf } from './products.service';

const cell = z.union([z.string().max(200), z.number()]).optional().transform((v) => (v === undefined ? '' : String(v).trim()));

const rowSchema = z
  .object({
    name: cell, company: cell, salt: cell, strength: cell, category: cell, schedule: cell, gst: cell, hsn: cell, barcode: cell,
    baseUnit: cell, saleUnit: cell, pack: cell, purchaseUnit: cell, purchasePack: cell, storage: cell, hasExpiry: cell,
    batch: cell, expiry: cell, quantity: cell, mrp: cell, rate: cell, minPrice: cell, rack: cell,
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
  /** null: a product-only row — stock comes later (Add stock or a purchase). */
  stock: { batchNumber: string; expiry: Date; quantity: number; mrp: number; minPrice: number | null; purchaseRate: number; rack: string } | null;
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
  const existing = await ProductModel.find({ shopId: t.shopId, nameLower: { $in: names } }).select('name nameLower units isActive scheduleType noExpiry').session(session ?? null).lean();
  const lotDay = istYmd(new Date());
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
    const no = /^(n|no|false|0|none|never)$/i.test(r.hasExpiry);
    if (r.hasExpiry && !no && !/^(y|yes|true|1)$/i.test(r.hasExpiry)) errors.push('Has expiry is Yes or No');
    let scheduleOf = known?.scheduleType ?? 'OTC';
    const noExpiry = known ? known.noExpiry : no;
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
        const purchase = r.purchaseUnit.toUpperCase() || sale;
        const pPack = purchase === sale ? 1 : Number(r.purchasePack || '0');
        if (!ALL_UNITS.includes(purchase)) errors.push(`Unknown purchase unit — use one of ${ALL_UNITS.join(', ')}`);
        units = { type, base, sale, salePack: pack, purchase, purchasePack: pPack, allowLooseSale: base !== sale };
        const problem = unitsProblem(units);
        if (problem) errors.push(problem);
      }
      const catName = r.category || CATEGORY_BY_BASE[base] || 'FMCG';
      const cat = catByKey.get(categoryKey(catName));
      if (!cat) errors.push(`Category “${r.category}” doesn’t exist — add it in Settings or leave it blank`);
      const schedule = (r.schedule.toUpperCase().replace(/^SCHEDULE\s*/, '').replace(/[\s-]/g, '_') || 'OTC') as (typeof SCHEDULE_TYPES)[number];
      if (!SCHEDULE_TYPES.includes(schedule)) errors.push('Schedule is OTC, H, H1, X or NON_DRUG');
      scheduleOf = schedule;
      const gst = r.gst ? Number(r.gst.replace('%', '')) : defaultGst;
      if (!(GST_RATES as readonly number[]).includes(gst)) errors.push('GST must be 0, 5, 12, 18, 28 or 40');
      const storage = /^(cold|fridge|2-8)/i.test(r.storage) ? 'COLD' : /^(controlled|locked)/i.test(r.storage) ? 'CONTROLLED' : 'NORMAL';
      if (r.storage && !/^(normal|cold|fridge|2-8|controlled|locked)/i.test(r.storage)) errors.push('Storage is Normal, Cold or Controlled');
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
          strength: r.strength, categoryId: cat._id, scheduleType: schedule, storageType: storage, hsnCode: r.hsn, gstRate: gst, barcode: r.barcode || undefined,
          units: toUnits(units), packSize: '', noExpiry, defaultRack: r.rack.toUpperCase(), reorderLevel: 0, reorderQuantity: 0,
        };
      }
    }

    const salePack = known ? packOf(known.units as Units) : (units?.salePack ?? 1);
    const saleName = known ? (known.units as Units).sale : (units?.sale ?? 'PIECE');
    // Stock columns are optional together: all blank = the product only.
    const hasStock = [r.batch, r.expiry, r.quantity, r.mrp, r.rate, r.minPrice].some(Boolean);
    if (!hasStock) {
      if (known) errors.push('Already in your products — fill batch, quantity, MRP and rate to add its stock');
      return { row: i + 1, name: r.name, product: known ? 'existing' : 'new', productId: known?._id, draft, stock: null, quantityLabel: '—', errors, warnings } satisfies Plan;
    }
    if (r.batch && !/^[A-Za-z0-9/-]{1,20}$/.test(r.batch)) errors.push('Batch number: letters, numbers, / and - only');
    const parsed = r.expiry ? parseExpiry(r.expiry) : undefined;
    if (r.expiry && !parsed && !noExpiry) errors.push('Expiry should look like 12/26 or 12/2026');
    const lot = lotOf({ noExpiry, scheduleType: scheduleOf }, r.batch.toUpperCase(), parsed ?? undefined, lotDay);
    if ('field' in lot) errors.push(lot.field === 'expiry' ? 'Expiry is missing (MM/YY) — or write No under Has expiry for a device' : 'Batch number is missing — only a non-medicine may leave it blank');
    const expiry = 'field' in lot ? null : lot.expiry;
    if (expiry && expiry.getTime() < Date.now()) warnings.push('Already expired — it will not sell');
    const qty = Number(r.quantity);
    if (!r.quantity || !Number.isInteger(qty) || qty < 1) errors.push('Quantity must be a whole number of ' + saleName);
    const mrp = rupees(r.mrp);
    if (mrp === null || mrp < 1 || mrp > MAX_PAISE) errors.push('MRP should be a price like 30.00');
    const rate = rupees(r.rate);
    if (rate === null || rate > MAX_PAISE) errors.push('Purchase rate should be a price like 21.00');
    const minPrice = r.minPrice ? rupees(r.minPrice) : null;
    if (r.minPrice && (minPrice === null || minPrice > MAX_PAISE)) errors.push('Lowest price should be a price like 25.00');
    if (minPrice !== null && mrp !== null && minPrice > mrp) warnings.push('Lowest price is above the MRP — check it');
    if (r.rack && !/^[A-Za-z0-9][A-Za-z0-9-]{0,11}$/.test(r.rack)) errors.push('Rack: letters, numbers and dashes, like A-2-1');
    const quantity = qty * salePack;
    if (quantity > MAX_QTY) errors.push('Quantity is too large');

    return {
      row: i + 1,
      name: r.name,
      product: known ? 'existing' : 'new',
      productId: known?._id,
      draft,
      stock: { batchNumber: 'field' in lot ? r.batch : lot.batchNumber, expiry: expiry ?? new Date(0), quantity, mrp: mrp ?? 0, minPrice, purchaseRate: rate ?? 0, rack: r.rack.toUpperCase() },
      quantityLabel: `${String(qty)} ${saleName}`,
      errors,
      warnings,
    };
  });
}

const view = (p: Plan[]) => ({
  rows: p.map(({ row, name, product, quantityLabel, errors, warnings, stock }) => ({ row, name, product, batch: stock?.batchNumber ?? '', quantity: quantityLabel, errors, warnings })),
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
      if (!r.stock) continue;
      const p = await ProductModel.findOne({ shopId: t.shopId, _id: productId }).select('name units storageType defaultRack').session(session).lean();
      if (!p) throw AppError.internal();
      const out = await receiveOpening(t.shopId, p, { ...r.stock, mrpChoice: 'separate' }, actor, session, now);
      if (out.how === 'merged') merged++;
      touched.add(String(productId));
    }
    await refreshRollups(t.shopId, [...touched].map((id) => new Types.ObjectId(id)), session, now);
    const stocked = rows.filter((r) => r.stock).length;
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'stock', entityName: 'Excel import', text: `${actor.name} imported ${String(rows.length)} rows — ${String(created.size)} new products, ${String(stocked)} stock rows`, ip }, session);
    return { rows: rows.length, newProducts: created.size, merged, stockRows: stocked };
  });
  return { ...view(preview), saved: true, result };
}


// Header text matches the import screen's column names, so a filled template maps itself.
const TEMPLATE_COLUMNS: [label: string, width: number][] = [
  ['Product name', 30], ['Company', 16], ['Salt / composition', 22], ['Strength', 10], ['Category', 18], ['Schedule', 10], ['GST %', 7], ['HSN', 10],
  ['Barcode', 15], ['Sale unit', 10], ['Base unit', 10], ['Units per sale unit', 10], ['Purchase unit', 11], ['Sale units per purchase unit', 12], ['Storage', 10],
  ['Has expiry (Yes/No)', 11], ['Batch number', 13], ['Expiry (MM/YY)', 10], ['Quantity (sale units)', 11], ['MRP (per sale unit)', 11], ['Purchase rate (per sale unit)', 13],
  ['Lowest price (per sale unit)', 13], ['Rack', 8],
];

// One sample per kind of thing a pharmacy sells (D59). GST: copy the rate from the supplier's invoice.
export const TEMPLATE_ROWS: (string | number)[][] = [
  ['Dolo 650 Tablet', 'Micro Labs', 'Paracetamol', '650 mg', 'Tablet', 'OTC', 12, '30049099', '8901234567890', 'STRIP', 'TABLET', 15, 'BOX', 10, 'Normal', 'Yes', 'DL2409', '08/27', 30, 33.5, 23.4, 32, 'A-2-1'],
  ['Dolo 650 Tablet', 'Micro Labs', 'Paracetamol', '650 mg', 'Tablet', 'OTC', 12, '30049099', '8901234567890', 'STRIP', 'TABLET', 15, 'BOX', 10, 'Normal', 'Yes', 'DL2501', '03/28', 20, 34, 24, '', 'A-2-1'],
  ['Mox 500 Capsule', 'Sun Pharma', 'Amoxicillin', '500 mg', 'Capsule', 'H', 12, '30041010', '', 'STRIP', 'CAPSULE', 10, 'BOX', 10, 'Normal', 'Yes', 'MX1123', '11/27', 15, 72.5, 51, '', 'A-3-1'],
  ['Alprax 0.25 Tablet', 'Torrent', 'Alprazolam', '0.25 mg', 'Tablet', 'H1', 12, '30049099', '', 'STRIP', 'TABLET', 15, 'BOX', 10, 'Normal', 'Yes', 'AL0425', '06/27', 10, 45, 28, '', 'B-1-1'],
  ['Benadryl Syrup 100 ml', 'J&J', 'Diphenhydramine', '', 'Syrup', 'OTC', 12, '30049099', '', 'BOTTLE', 'BOTTLE', 1, 'BOX', 24, 'Normal', 'Yes', 'BD8812', '02/27', 9, 143, 101, '', 'C-2-1'],
  ['Huminsulin R 40IU Vial', 'Lilly', 'Human insulin', '40 IU/ml', 'Injection', 'H', 5, '30043110', '', 'VIAL', 'VIAL', 1, 'BOX', 10, 'Cold', 'Yes', 'HR2206', '05/27', 4, 158, 120, '', 'FRIDGE-1'],
  ['Betadine Ointment 20 g', 'Win-Medicare', 'Povidone iodine', '5%', 'Ointment', 'OTC', 12, '30049099', '', 'TUBE', 'TUBE', 1, 'BOX', 12, 'Normal', 'Yes', 'BT3301', '09/27', 6, 125, 88, '', 'D-1-2'],
  ['Moxiflox Eye Drops 5 ml', 'Cipla', 'Moxifloxacin', '0.5%', 'Drops', 'H', 12, '30049099', '', 'BOTTLE', 'BOTTLE', 1, 'BOX', 20, 'Normal', 'Yes', 'MF7710', '12/26', 5, 96, 66, '', 'D-2-1'],
  ['Cadbury Dairy Milk Silk 60 g', 'Mondelez', '', '', 'Chocolate & snacks', 'NON_DRUG', 5, '1806', '', 'BAR', 'BAR', 1, 'BOX', 24, 'Normal', 'Yes', '', '04/27', 12, 80, 68, '', 'COUNTER'],
  ['Coca-Cola 300 ml Can', 'Coca-Cola', '', '', 'Drinks', 'NON_DRUG', 40, '2202', '', 'CAN', 'CAN', 1, 'CASE', 24, 'Normal', 'Yes', '', '01/27', 24, 40, 30, '', 'FRIDGE-2'],
  ["Johnson's Baby Lotion 100 ml", 'J&J', '', '', 'Baby care', 'NON_DRUG', 18, '3304', '', 'BOTTLE', 'BOTTLE', 1, 'BOX', 12, 'Normal', 'Yes', 'JB5501', '10/27', 6, 185, 140, '', 'E-1-1'],
  ['Omron BP Monitor HEM-7120', 'Omron', '', '', 'Device', 'NON_DRUG', 18, '9018', '', 'PIECE', 'PIECE', 1, 'BOX', 10, 'Normal', 'No', '', '', 2, 2450, 1800, 2200, 'E-2-1'],
  ['Surgical Gloves (pair)', 'Kanam', '', '', 'Surgical', 'NON_DRUG', 12, '4015', '', 'PAIR', 'PAIR', 1, 'BOX', 50, 'Normal', 'Yes', 'KG1201', '07/28', 50, 15, 9, '', 'E-3-1'],
  ['Pan 40 Tablet', 'Alkem', 'Pantoprazole', '40 mg', 'Tablet', 'H', 12, '30049099', '', 'STRIP', 'TABLET', 15, 'BOX', 10, 'Normal', 'Yes', '', '', '', '', '', '', 'A-1-3'],
];

const HOW_TO: [column: string, needed: string, what: string][] = [
  ['Product name', 'Yes', 'As on the pack. The same name twice = another batch of the same product (see Dolo 650 rows).'],
  ['Company', 'No', 'Manufacturer.'],
  ['Salt / composition · Strength', 'No', 'Helps search by salt and shows similar medicines.'],
  ['Category', 'No', 'One of your categories: Tablet, Capsule, Syrup, Injection, Ointment, Drops, Powder, Surgical, FMCG, Ayurvedic, Device, Chocolate & snacks, Drinks, Baby care, Personal care, Nutrition.'],
  ['Schedule', 'No', 'OTC (no prescription) · H (prescription) · H1 (doctor + patient on the bill) · X (narcotic) · NON_DRUG (not a medicine). Blank = OTC.'],
  ['GST %', 'No', '0, 5, 12, 18, 28 or 40 — copy it from the supplier’s invoice; ask your CA when unsure. Blank = the shop’s default.'],
  ['HSN · Barcode', 'No', 'HSN 4–8 digits from the invoice. Barcode from the pack (4–32 letters or digits).'],
  ['Sale unit · Base unit · Units per sale unit', 'For new products', 'How you sell and how stock is counted: STRIP of 15 TABLET → STRIP, TABLET, 15. A bottle, bar or can → the same unit twice and 1.'],
  ['Purchase unit · Sale units per purchase unit', 'No', 'How the supplier sells it: BOX of 10 STRIP → BOX, 10. Blank = same as the sale unit.'],
  ['Storage', 'No', 'Normal · Cold (fridge 2–8°C, insulin) · Controlled (locked, Schedule X). Blank = Normal.'],
  ['Has expiry (Yes/No)', 'No', 'No for things that never expire (BP monitor, thermometer): expiry is not asked. Blank = Yes.'],
  ['Batch number', 'Medicines', 'Printed on the strip or box. A non-medicine may leave it blank — it gets today’s lot number (LOT-YYMMDD).'],
  ['Expiry (MM/YY)', 'If it expires', 'Month and year on the pack, like 08/27. It runs to the end of that month.'],
  ['Quantity (sale units)', 'With stock', 'How many sale units are on the shelf now: 30 = 30 strips.'],
  ['MRP · Purchase rate (per sale unit)', 'With stock', 'MRP printed on the pack (GST included) and what you paid per sale unit before GST, like 33.50 and 23.40.'],
  ['Lowest price (per sale unit)', 'No', 'A price floor for the seller — billing only flags a sale under it, never blocks.'],
  ['Rack', 'No', 'Where it sits, like A-2-1.'],
  ['Stock columns all blank', '—', 'Adds the product only (see Pan 40). Add its stock later from the product screen or a purchase entry.'],
];

/** The import template: a filled sample for every kind of product, and a sheet that explains each column. */
export async function importTemplate(): Promise<Buffer> {
  const bold = (value: string) => ({ value, fontWeight: 'bold' as const });
  return writeXlsxFile([
    { sheet: 'Products', data: [TEMPLATE_COLUMNS.map(([l]) => bold(l)), ...TEMPLATE_ROWS.map((r) => r.map((value) => ({ value })))], columns: TEMPLATE_COLUMNS.map(([, width]) => ({ width })) },
    { sheet: 'How to fill', data: [[bold('Column'), bold('Needed?'), bold('What to write')], ...HOW_TO.map((r) => r.map((value) => ({ value })))], columns: [{ width: 34 }, { width: 16 }, { width: 110 }] },
  ]).toBuffer();
}
