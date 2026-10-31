import { Types, type PipelineStage } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { fromBase, type Units } from '../../utils/units';
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

type Out = { rows: Row[]; count: number; summary: { schedule: string; lines: number; docs: number }[] };
const facet = (limit: number, docKey: string): PipelineStage[] => [
  {
    $facet: {
      rows: [{ $limit: limit }],
      count: [{ $count: 'n' }],
      summary: [{ $group: { _id: '$schedule', lines: { $sum: 1 }, docs: { $addToSet: docKey } } }, { $project: { _id: 0, schedule: '$_id', lines: 1, docs: { $size: '$docs' } } }, { $sort: { schedule: 1 } }],
    },
  },
];

async function sales(t: TenantContext, f: Filters, limit: number): Promise<Out> {
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
  const [r] = await SaleModel.aggregate<{ rows: { billDate: Date; billNumber: string; customerName: string; customerPhone: string; patientName: string; doctorName: string; rxNumber: string; schedule: string; l: { productName: string; category: string; batchNumber: string; expiryDate: Date; quantityInBase: number; returnedQuantity: number; unit: string; baseUnit: string; salePack: number; mrp: number; totalAmount: number } }[]; count: { n: number }[]; summary: Out['summary'] }>([
    { $match: { ...bill, ...line } },
    { $sort: { billDate: -1, _id: -1 } },
    { $unwind: '$lines' },
    { $match: line },
    { $project: { billDate: 1, billNumber: 1, customerName: 1, customerPhone: 1, patientName: 1, doctorName: 1, rxNumber: 1, schedule: '$lines.schedule', l: '$lines' } },
    ...facet(limit, '$_id'),
  ]);
  return {
    count: r?.count[0]?.n ?? 0,
    summary: r?.summary ?? [],
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

async function stock(t: TenantContext, f: Filters, limit: number, now = new Date()): Promise<Out> {
  const batch: Record<string, unknown> = { shopId: t.shopId, quantity: { $gt: 0 }, status: { $ne: 'returned' } };
  if (f.expiry === 'expired') batch.expiryDate = { $lt: now };
  if (f.expiry === 'soon') batch.expiryDate = { $gte: now, $lt: new Date(now.getTime() + 90 * DAY) };
  const [r] = await BatchModel.aggregate<{ rows: { batchNumber: string; expiryDate: Date; quantity: number; rack: string; purchaseInvoiceNumber?: string; receivedAt: Date; mrp: number; schedule: string; category: string; p: { name: string; units: Units }; sup: { name: string }[] }[]; count: { n: number }[]; summary: Out['summary'] }>([
    { $match: batch },
    ...productFacts('productId'),
    { $match: productMatch(f) },
    { $lookup: { from: SupplierModel.collection.name, localField: 'supplierId', foreignField: '_id', as: 'sup', pipeline: [{ $project: { name: 1 } }] } },
    ...(f.party ? [{ $match: { 'sup.name': like(f.party) } }] : []),
    { $sort: { 'p.name': 1, expiryDate: 1 } },
    ...facet(limit, '$productId'),
  ]);
  return {
    count: r?.count[0]?.n ?? 0,
    summary: r?.summary ?? [],
    rows: (r?.rows ?? []).map((x) => ({ drug: x.p.name, schedule: x.schedule, category: x.category, batch: x.batchNumber, expiry: expiryText(x.expiryDate), qty: fromBase(x.quantity, x.p.units), rack: x.rack, supplier: x.sup[0]?.name ?? 'Opening stock', invoice: x.purchaseInvoiceNumber ?? '', received: x.receivedAt.toISOString(), mrp: x.mrp })),
  };
}

async function purchases(t: TenantContext, f: Filters, limit: number): Promise<Out> {
  const doc: Record<string, unknown> = { shopId: t.shopId, status: 'active', invoiceDate: range(f) };
  if (f.party) doc.supplierName = like(f.party);
  const [r] = await PurchaseModel.aggregate<{ rows: { invoiceDate: Date; purchaseNumber: string; invoiceNumber: string; supplierName: string; schedule: string; category: string; p: { name: string }; sup: { gstin: string }[]; l: { batchNumber: string; expiryDate: Date; quantity: number; freeQuantity: number; unit: string; mrp: number } }[]; count: { n: number }[]; summary: Out['summary'] }>([
    { $match: doc },
    { $sort: { invoiceDate: -1, _id: -1 } },
    { $unwind: '$lines' },
    { $set: { l: '$lines' } },
    ...productFacts('lines.productId'),
    { $match: productMatch(f) },
    { $lookup: { from: SupplierModel.collection.name, localField: 'supplierId', foreignField: '_id', as: 'sup', pipeline: [{ $project: { gstin: 1 } }] } },
    { $project: { invoiceDate: 1, purchaseNumber: 1, invoiceNumber: 1, supplierName: 1, schedule: 1, category: 1, p: 1, sup: 1, l: 1 } },
    ...facet(limit, '$_id'),
  ]);
  return {
    count: r?.count[0]?.n ?? 0,
    summary: r?.summary ?? [],
    rows: (r?.rows ?? []).map((x) => ({ date: x.invoiceDate.toISOString(), purchase: x.purchaseNumber, invoice: x.invoiceNumber, supplier: x.supplierName, gstin: x.sup[0]?.gstin ?? '', drug: x.p.name, schedule: x.schedule, category: x.category, batch: x.l.batchNumber, expiry: expiryText(x.l.expiryDate), qty: `${String(x.l.quantity)} ${x.l.unit}`, free: x.l.freeQuantity ? `${String(x.l.freeQuantity)} ${x.l.unit}` : '', mrp: x.l.mrp })),
  };
}

export async function register(t: TenantContext, kind: Kind, f: Filters, all = false) {
  const limit = all ? MAX : SCREEN;
  const out = kind === 'sales' ? await sales(t, f, limit) : kind === 'stock' ? await stock(t, f, limit) : await purchases(t, f, limit);
  return { key: kind, name: NAMES[kind], cols: COLS[kind], ...out };
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
    f.doctor ? `doctor “${f.doctor}”` : '',
    f.pay.length ? f.pay.join(' / ') : '',
    f.min !== undefined || f.max !== undefined ? `bills ${f.min !== undefined ? rs(f.min) : '₹0'}–${f.max !== undefined ? rs(f.max) : 'any'}` : '',
    kind === 'stock' && f.expiry === 'expired' ? 'expired' : kind === 'stock' && f.expiry === 'soon' ? 'expiring in 3 months' : '',
  ].filter(Boolean);
  return [span, ...bits].join(' · ');
}
