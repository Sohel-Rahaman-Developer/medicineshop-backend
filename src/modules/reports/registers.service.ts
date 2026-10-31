import { Types, type PipelineStage } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { fromBase, unitWords, type Units } from '../../utils/units';
import { CategoryModel } from '../categories/category.model';
import { ProductModel } from '../products/product.model';
import { PurchaseModel } from '../purchases/purchase.model';
import { SaleModel } from '../sales/sale.model';
import { BatchModel } from '../stock/batch.model';
import { SupplierModel } from '../suppliers/supplier.model';
import type { Col, Row } from './catalog';

// Registers for the shop and a drug inspector: any medicine's sales, stock and purchases, filtered every way the
// records allow. Never cost or profit — and every filter is on the bills' own facts.

const DAY = 86_400_000;
const SCREEN = 300;
const MAX = 20_000;
export const KINDS = ['sales', 'stock', 'purchases'] as const;
export type Kind = (typeof KINDS)[number];
export interface Filters {
  from?: Date;
  to?: Date;
  schedule: string[];
  category: string[];
  q?: string;
  party?: string;
  /** Stock and purchases: one supplier's id, or 'opening' for stock that came with no supplier. */
  supplier?: string;
  supplierName?: string;
  doctor?: string;
  pay: string[];
  staff?: string;
  min?: number;
  max?: number;
  expiry?: 'all' | 'expired' | 'soon';
}

const c = (key: string, label: string, kind: Col['kind'] = 'text'): Col => ({ key, label, kind });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const like = (s: string) => ({ $regex: escape(s), $options: 'i' });
const lineUnits = (l: { baseUnit: string; unit: string; salePack: number }): Units => ({ type: 'COUNT', base: l.baseUnit, sale: l.unit, purchase: l.unit, conversions: { [l.baseUnit]: 1, [l.unit]: l.salePack }, allowLooseSale: true });
const dayEnd = (d: Date) => new Date(d.getTime() + DAY - 1);
const range = (f: Filters) => ({ ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: dayEnd(f.to) } : {}) });

export const COLS: Record<Kind, Col[]> = {
  sales: [c('date', 'Date', 'datetime'), c('bill', 'Bill'), c('customer', 'Customer'), c('phone', 'Phone'), c('patient', 'Patient'), c('doctor', 'Doctor'), c('rx', 'Rx no.'), c('drug', 'Medicine'), c('schedule', 'Schedule'), c('category', 'Category'), c('batch', 'Batch'), c('expiry', 'Expiry'), c('qty', 'Qty'), c('mrp', 'MRP', 'money'), c('amount', 'Amount', 'money')],
  stock: [c('drug', 'Medicine'), c('schedule', 'Schedule'), c('category', 'Category'), c('batch', 'Batch'), c('expiry', 'Expiry'), c('qty', 'In stock'), c('rack', 'Rack'), c('supplier', 'Supplier'), c('invoice', 'Invoice'), c('received', 'Received', 'date'), c('mrp', 'MRP', 'money')],
  purchases: [c('date', 'Date', 'date'), c('purchase', 'Purchase'), c('invoice', 'Invoice'), c('supplier', 'Supplier'), c('gstin', 'Supplier GSTIN'), c('drug', 'Medicine'), c('schedule', 'Schedule'), c('category', 'Category'), c('batch', 'Batch'), c('expiry', 'Expiry'), c('qty', 'Qty'), c('free', 'Free'), c('mrp', 'MRP', 'money')],
};
export const NAMES: Record<Kind, string> = { sales: 'Sales register', stock: 'Stock register', purchases: 'Purchase register' };

const mmyy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear())}`;
const expiryText = (d: Date) => (d.getUTCFullYear() >= 9999 ? 'No expiry' : mmyy(new Date(d.getTime() + 5.5 * 3600_000)));

/** Sales only: every matching bill's own amount added up, and the shown lines' amounts — never a chosen subset. */
export interface Totals { bills: number; billTotal: number; lineTotal: number }
export const VIEWS = { sales: ['category', 'medicine', 'doctor', 'customer', 'day', 'schedule'], stock: ['category', 'medicine', 'supplier', 'schedule'], purchases: ['supplier', 'category', 'medicine'] } as const satisfies Record<Kind, readonly string[]>;
export const ALL_VIEWS = ['category', 'medicine', 'doctor', 'customer', 'day', 'schedule', 'supplier'] as const;
export type View = (typeof ALL_VIEWS)[number];
/** One row per category, medicine, doctor…: distinct medicines and bills, lines, quantity per base unit, and (sales only) the amount. */
export interface GroupRow { key: string; label: string; sub: string; medicines: number; docs: number; lines: number; qty: string; amount: number | null }
type RawGroup = Omit<GroupRow, 'qty' | 'amount'> & { qty: { unit: string; n: number }[]; amount: number };
type Out = { rows: Row[]; count: number; summary: { schedule: string; lines: number; docs: number }[]; totals: Totals | null; groups: RawGroup[] | null };
type Spec = { key: unknown; label: unknown; sub?: unknown };
type Measure = { med: string; doc: string; unit: string; n: unknown; amount?: string };
const union = (f: string) => ({ $size: { $reduce: { input: f, initialValue: [], in: { $setUnion: ['$$value', '$$this'] } } } });
const str = (f: string) => ({ $ifNull: [f, ''] });
const grouped = (g: Spec, m: Measure, byKey: boolean): PipelineStage.FacetPipelineStage[] => [
  { $group: { _id: { k: g.key, u: m.unit }, label: { $first: g.label }, sub: { $first: g.sub ?? '' }, q: { $sum: m.n }, meds: { $addToSet: m.med }, docs: { $addToSet: m.doc }, lines: { $sum: 1 }, amount: { $sum: m.amount ?? 0 } } },
  { $group: { _id: '$_id.k', label: { $first: '$label' }, sub: { $first: '$sub' }, qty: { $push: { unit: '$_id.u', n: '$q' } }, meds: { $push: '$meds' }, docs: { $push: '$docs' }, lines: { $sum: '$lines' }, amount: { $sum: '$amount' } } },
  { $project: { _id: 0, key: '$_id', label: 1, sub: 1, qty: 1, lines: 1, amount: 1, medicines: union('$meds'), docs: union('$docs') } },
  { $sort: byKey ? { key: -1 } : { amount: -1, lines: -1, label: 1 } },
  { $limit: 1000 },
];
const salesGroup: Record<(typeof VIEWS.sales)[number], Spec> = {
  category: { key: str('$l.category'), label: str('$l.category') },
  medicine: { key: { $toString: '$l.productId' }, label: '$l.productName', sub: str('$l.category') },
  doctor: { key: str('$doctorName'), label: str('$doctorName') },
  customer: { key: { $cond: [{ $gt: [{ $strLenCP: str('$customerPhone') }, 0] }, '$customerPhone', str('$customerName')] }, label: str('$customerName'), sub: str('$customerPhone') },
  day: { key: { $dateToString: { date: '$billDate', format: '%Y-%m-%d', timezone: '+05:30' } }, label: '' },
  schedule: { key: '$schedule', label: '$schedule' },
};
const stockGroup: Record<(typeof VIEWS.stock)[number], Spec> = {
  category: { key: '$category', label: '$category' },
  medicine: { key: { $toString: '$productId' }, label: '$p.name', sub: '$category' },
  supplier: { key: { $ifNull: [{ $toString: '$supplierId' }, 'opening'] }, label: { $ifNull: [{ $first: '$sup.name' }, 'Opening stock'] } },
  schedule: { key: '$schedule', label: '$schedule' },
};
const purchaseGroup: Record<(typeof VIEWS.purchases)[number], Spec> = {
  supplier: { key: { $toString: '$supplierId' }, label: '$supplierName' },
  category: { key: '$category', label: '$category' },
  medicine: { key: { $toString: '$p._id' }, label: '$p.name', sub: '$category' },
};
const spec = (table: Partial<Record<View, Spec>>, v: View | undefined): Spec | undefined => (v ? table[v] : undefined);
const facet = (limit: number, docKey: string, extra: Record<string, PipelineStage.FacetPipelineStage[] | false> = {}): PipelineStage[] => [
  {
    $facet: {
      rows: [{ $limit: limit }],
      ...Object.fromEntries(Object.entries(extra).filter((e): e is [string, PipelineStage.FacetPipelineStage[]] => e[1] !== false)),
      count: [{ $count: 'n' }],
      summary: [{ $group: { _id: '$schedule', lines: { $sum: 1 }, docs: { $addToSet: docKey } } }, { $project: { _id: 0, schedule: '$_id', lines: 1, docs: { $size: '$docs' } } }, { $sort: { schedule: 1 } }],
    },
  },
];

async function sales(t: TenantContext, f: Filters, limit: number, view?: View): Promise<Out> {
  const g = spec(salesGroup, view);
  const bill: Record<string, unknown> = { shopId: t.shopId, billDate: range(f), status: { $ne: 'cancelled' } };
  if (f.party) bill.$or = [{ customerName: like(f.party) }, { customerPhone: like(f.party.replace(/\D/g, '') || f.party) }, { patientName: like(f.party) }];
  if (f.doctor) bill.doctorName = like(f.doctor);
  if (f.pay.length) bill['payments.mode'] = { $in: f.pay };
  if (f.staff) bill.createdBy = new Types.ObjectId(f.staff);
  if (f.min !== undefined || f.max !== undefined) bill.grandTotal = { ...(f.min !== undefined ? { $gte: f.min } : {}), ...(f.max !== undefined ? { $lte: f.max } : {}) };
  const line: Record<string, unknown> = {};
  if (f.schedule.length) line['lines.schedule'] = { $in: f.schedule };
  if (f.category.length) line['lines.category'] = { $in: f.category };
  if (f.q) line['lines.productName'] = like(f.q);
  const [r] = await SaleModel.aggregate<{ rows: { billDate: Date; billNumber: string; customerName: string; customerPhone: string; patientName: string; doctorName: string; rxNumber: string; schedule: string; l: { productName: string; category: string; batchNumber: string; expiryDate: Date; quantityInBase: number; returnedQuantity: number; unit: string; baseUnit: string; salePack: number; mrp: number; totalAmount: number } }[]; count: { n: number }[]; summary: Out['summary']; totals: Totals[]; groups?: RawGroup[] }>([
    { $match: { ...bill, ...line } },
    { $sort: { billDate: -1, _id: -1 } },
    { $unwind: '$lines' },
    { $match: line },
    { $project: { billDate: 1, billNumber: 1, grandTotal: 1, customerName: 1, customerPhone: 1, patientName: 1, doctorName: 1, rxNumber: 1, schedule: '$lines.schedule', l: '$lines' } },
    ...facet(limit, '$_id', {
      totals: [
        { $group: { _id: '$_id', bill: { $first: '$grandTotal' }, lines: { $sum: '$l.totalAmount' } } },
        { $group: { _id: null, bills: { $sum: 1 }, billTotal: { $sum: '$bill' }, lineTotal: { $sum: '$lines' } } },
        { $project: { _id: 0, bills: 1, billTotal: 1, lineTotal: 1 } },
      ],
      groups: g ? grouped(g, { med: '$l.productId', doc: '$_id', unit: '$l.baseUnit', n: '$l.quantityInBase', amount: '$l.totalAmount' }, view === 'day') : false,
    }),
  ]);
  return {
    count: r?.count[0]?.n ?? 0,
    summary: r?.summary ?? [],
    totals: r?.totals[0] ?? { bills: 0, billTotal: 0, lineTotal: 0 },
    groups: r?.groups ?? null,
    rows: (r?.rows ?? []).map((x) => ({
      date: x.billDate.toISOString(),
      bill: x.billNumber,
      customer: x.customerName,
      phone: x.customerPhone,
      patient: x.patientName,
      doctor: x.doctorName,
      rx: x.rxNumber,
      drug: x.l.productName,
      schedule: x.schedule,
      category: x.l.category,
      batch: x.l.batchNumber,
      expiry: expiryText(x.l.expiryDate),
      qty: `${fromBase(x.l.quantityInBase, lineUnits(x.l))}${x.l.returnedQuantity ? ` (${fromBase(x.l.returnedQuantity, lineUnits(x.l))} returned)` : ''}`,
      mrp: x.l.mrp,
      amount: x.l.totalAmount,
    })),
  };
}

/** Product facts the stock and purchase lines don't carry: schedule and category, by lookup. */
const productFacts = (local: string): PipelineStage[] => [
  { $lookup: { from: ProductModel.collection.name, localField: local, foreignField: '_id', as: 'p', pipeline: [{ $project: { name: 1, scheduleType: 1, categoryId: 1, units: 1 } }] } },
  { $unwind: '$p' },
  { $lookup: { from: CategoryModel.collection.name, localField: 'p.categoryId', foreignField: '_id', as: 'cat', pipeline: [{ $project: { name: 1 } }] } },
  { $set: { schedule: '$p.scheduleType', category: { $ifNull: [{ $first: '$cat.name' }, ''] } } },
];
const productMatch = (f: Filters) => ({
  ...(f.schedule.length ? { schedule: { $in: f.schedule } } : {}),
  ...(f.category.length ? { category: { $in: f.category } } : {}),
  ...(f.q ? { 'p.name': like(f.q) } : {}),
});

async function stock(t: TenantContext, f: Filters, limit: number, view?: View, now = new Date()): Promise<Out> {
  const g = spec(stockGroup, view);
  const batch: Record<string, unknown> = { shopId: t.shopId, quantity: { $gt: 0 }, status: { $ne: 'returned' } };
  if (f.supplier) batch.supplierId = f.supplier === 'opening' ? null : new Types.ObjectId(f.supplier);
  if (f.expiry === 'expired') batch.expiryDate = { $lt: now };
  if (f.expiry === 'soon') batch.expiryDate = { $gte: now, $lt: new Date(now.getTime() + 90 * DAY) };
  const [r] = await BatchModel.aggregate<{ rows: { batchNumber: string; expiryDate: Date; quantity: number; rack: string; purchaseInvoiceNumber?: string; receivedAt: Date; mrp: number; schedule: string; category: string; p: { name: string; units: Units }; sup: { name: string }[] }[]; count: { n: number }[]; summary: Out['summary']; groups?: RawGroup[] }>([
    { $match: batch },
    ...productFacts('productId'),
    { $match: productMatch(f) },
    { $lookup: { from: SupplierModel.collection.name, localField: 'supplierId', foreignField: '_id', as: 'sup', pipeline: [{ $project: { name: 1 } }] } },
    ...(f.party ? [{ $match: { 'sup.name': like(f.party) } }] : []),
    { $sort: { 'p.name': 1, expiryDate: 1 } },
    ...facet(limit, '$productId', { groups: g ? grouped(g, { med: '$productId', doc: '$_id', unit: '$p.units.base', n: '$quantity' }, false) : false }),
  ]);
  return {
    count: r?.count[0]?.n ?? 0,
    summary: r?.summary ?? [],
    totals: null,
    groups: r?.groups ?? null,
    rows: (r?.rows ?? []).map((x) => ({ drug: x.p.name, schedule: x.schedule, category: x.category, batch: x.batchNumber, expiry: expiryText(x.expiryDate), qty: fromBase(x.quantity, x.p.units), rack: x.rack, supplier: x.sup[0]?.name ?? 'Opening stock', invoice: x.purchaseInvoiceNumber ?? '', received: x.receivedAt.toISOString(), mrp: x.mrp })),
  };
}

async function purchases(t: TenantContext, f: Filters, limit: number, view?: View): Promise<Out> {
  const g = spec(purchaseGroup, view);
  const doc: Record<string, unknown> = { shopId: t.shopId, status: 'active', invoiceDate: range(f) };
  if (f.party) doc.supplierName = like(f.party);
  if (f.supplier) doc.supplierId = f.supplier === 'opening' ? null : new Types.ObjectId(f.supplier);
  const [r] = await PurchaseModel.aggregate<{ rows: { invoiceDate: Date; purchaseNumber: string; invoiceNumber: string; supplierName: string; schedule: string; category: string; p: { name: string }; sup: { gstin: string }[]; l: { batchNumber: string; expiryDate: Date; quantity: number; freeQuantity: number; unit: string; mrp: number } }[]; count: { n: number }[]; summary: Out['summary']; groups?: RawGroup[] }>([
    { $match: doc },
    { $sort: { invoiceDate: -1, _id: -1 } },
    { $unwind: '$lines' },
    { $set: { l: '$lines' } },
    ...productFacts('lines.productId'),
    { $match: productMatch(f) },
    { $lookup: { from: SupplierModel.collection.name, localField: 'supplierId', foreignField: '_id', as: 'sup', pipeline: [{ $project: { gstin: 1 } }] } },
    { $project: { invoiceDate: 1, purchaseNumber: 1, invoiceNumber: 1, supplierId: 1, supplierName: 1, schedule: 1, category: 1, p: 1, sup: 1, l: 1 } },
    ...facet(limit, '$_id', { groups: g ? grouped(g, { med: '$p._id', doc: '$_id', unit: '$l.unit', n: { $add: ['$l.quantity', { $ifNull: ['$l.freeQuantity', 0] }] } }, false) : false }),
  ]);
  return {
    count: r?.count[0]?.n ?? 0,
    summary: r?.summary ?? [],
    totals: null,
    groups: r?.groups ?? null,
    rows: (r?.rows ?? []).map((x) => ({ date: x.invoiceDate.toISOString(), purchase: x.purchaseNumber, invoice: x.invoiceNumber, supplier: x.supplierName, gstin: x.sup[0]?.gstin ?? '', drug: x.p.name, schedule: x.schedule, category: x.category, batch: x.l.batchNumber, expiry: expiryText(x.l.expiryDate), qty: `${String(x.l.quantity)} ${x.l.unit}`, free: x.l.freeQuantity ? `${String(x.l.freeQuantity)} ${x.l.unit}` : '', mrp: x.l.mrp })),
  };
}

const dayParts = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dayName = (d: Date) => {
  const piece = (t: string) => dayParts.formatToParts(d).find((x) => x.type === t)?.value ?? '';
  return `${piece('weekday')}, ${piece('day')} ${piece('month')} ${piece('year')}`;
};
const EMPTY: Partial<Record<View, string>> = { category: 'No category', doctor: 'No doctor', customer: 'Walk-in' };

/** A group's own words: "No doctor" for bills without one, the day spelled out, a schedule's full name. */
function named(kind: Kind, view: View, x: RawGroup): GroupRow {
  const label = view === 'day' ? dayName(new Date(`${x.key}T12:00:00+05:30`)) : view === 'schedule' ? (SCHEDULE_NAME[x.key] ?? x.key) : x.label || (EMPTY[view] ?? '—');
  const qty = [...x.qty].sort((a, b) => b.n - a.n).map((q) => unitWords(q.n, q.unit)).join(' · ');
  return { key: x.key, label, sub: x.sub, medicines: x.medicines, docs: x.docs, lines: x.lines, qty, amount: kind === 'sales' ? x.amount : null };
}

export async function register(t: TenantContext, kind: Kind, f: Filters, all = false, view?: View) {
  const limit = all ? MAX : SCREEN;
  const out = kind === 'sales' ? await sales(t, f, limit, view) : kind === 'stock' ? await stock(t, f, limit, view) : await purchases(t, f, limit, view);
  return { key: kind, name: NAMES[kind], cols: COLS[kind], ...out, groups: view && out.groups ? out.groups.map((x) => named(kind, view, x)) : null };
}

const SCHEDULE_NAME: Record<string, string> = { OTC: 'OTC', H: 'Schedule H', H1: 'Schedule H1', X: 'Schedule X', NON_DRUG: 'Non-drug' };

/** The report's own name says what was chosen — "Sales register · Schedule H1 · Tablet · bills ₹500–₹5,000". */
export function describe(kind: Kind, f: Filters, span: string) {
  const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;
  const bits = [
    f.schedule.length ? f.schedule.map((s) => SCHEDULE_NAME[s] ?? s).join(', ') : '',
    f.category.join(', '),
    f.q ? `medicine “${f.q}”` : '',
    f.party ? `${kind === 'sales' ? 'customer' : 'supplier'} “${f.party}”` : '',
    f.supplier ? (f.supplier === 'opening' ? 'opening stock' : `supplier ${f.supplierName ?? ''}`.trim()) : '',
    f.doctor ? `doctor “${f.doctor}”` : '',
    f.pay.length ? f.pay.join(' / ') : '',
    f.min !== undefined || f.max !== undefined ? `bills ${f.min !== undefined ? rs(f.min) : '₹0'}–${f.max !== undefined ? rs(f.max) : 'any'}` : '',
    kind === 'stock' && f.expiry === 'expired' ? 'expired' : kind === 'stock' && f.expiry === 'soon' ? 'expiring in 3 months' : '',
  ].filter(Boolean);
  return [span, ...bits].join(' · ');
}
