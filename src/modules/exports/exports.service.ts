import { day, dayTime, mmyy, pdfTable, rupees, xlsx } from '../../core/export';
import type { TenantContext } from '../../core/middleware/tenant';
import { fromBase, type Units } from '../../utils/units';
import { list as listProducts, seesCost } from '../products/products.service';
import type { ListQuery } from '../products/products.validation';
import { get as getPurchase } from '../purchases/purchases.service';
import { movements, reorder } from '../stock/stock.service';
import type { MovementsQuery } from '../stock/stock.validation';
import { ledger, type LedgerRow } from '../suppliers/suppliers.service';

const MAX_ROWS = 20_000;

/** Reads a cursor list to the end (or MAX_ROWS) — exports are server-side, never a page of the screen. */
async function all<T>(read: (cursor?: string) => Promise<{ items: T[]; meta: { nextCursor: string | null } }>) {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const { items, meta } = await read(cursor);
    out.push(...items);
    cursor = meta.nextCursor ?? undefined;
  } while (cursor && out.length < MAX_ROWS);
  return out.slice(0, MAX_ROWS);
}

export async function productsXlsx(t: TenantContext, q: ListQuery) {
  const cost = seesCost(t);
  const rows = await all((cursor) => listProducts(t, { ...q, cursor, limit: 100 }));
  type R = (typeof rows)[number];
  const units = (r: R): Units => ({ type: 'COUNT', base: r.units.base, sale: r.units.sale, purchase: r.units.sale, conversions: { [r.units.base]: 1, [r.units.sale]: r.units.salePack }, allowLooseSale: false });
  return xlsx<R>(
    [
      { label: 'Product', get: (r) => r.name, w: 2.4 },
      { label: 'Salt', get: (r) => `${r.salt} ${r.strength}`.trim(), w: 2 },
      { label: 'Company', get: (r) => r.company, w: 1.6 },
      { label: 'Category', get: (r) => r.category },
      { label: 'Schedule', get: (r) => r.scheduleType },
      { label: 'Sellable (base)', get: (r) => r.stock.sellable, num: true },
      { label: 'Sellable', get: (r) => fromBase(r.stock.sellable, units(r)), w: 1.6 },
      { label: 'Expired', get: (r) => r.stock.expired, num: true },
      { label: 'Blocked', get: (r) => r.stock.blocked, num: true },
      { label: 'Rack', get: (r) => r.rack },
      { label: 'Next expiry', get: (r) => (r.stock.nextExpiry ? mmyy(r.stock.nextExpiry) : '') },
      { label: 'MRP value (₹)', get: (r) => r.stock.mrpValue / 100, num: true },
      ...(cost ? [{ label: 'Value at cost (₹)', get: (r: R) => (r.stock.value ?? 0) / 100, num: true }] : []),
    ],
    rows,
  );
}

export async function movementsXlsx(t: TenantContext, q: MovementsQuery) {
  const rows = await all((cursor) => movements(t, { ...q, cursor, limit: 100 }));
  return xlsx<(typeof rows)[number]>(
    [
      { label: 'Date', get: (m) => dayTime(m.at), w: 1.6 },
      { label: 'Product', get: (m) => m.productName, w: 2.2 },
      { label: 'Batch', get: (m) => m.batchNumber },
      { label: 'Type', get: (m) => m.type, w: 1.4 },
      { label: 'Qty', get: (m) => m.quantity, num: true },
      { label: 'Before', get: (m) => m.balanceBefore, num: true },
      { label: 'After', get: (m) => m.balanceAfter, num: true },
      { label: 'Unit', get: (m) => m.units.base },
      { label: 'Ref', get: (m) => m.refNumber ?? '', w: 1.4 },
      { label: 'User', get: (m) => m.userName, w: 1.4 },
      { label: 'Reason', get: (m) => m.reason ?? '', w: 2 },
    ],
    rows,
  );
}

export async function purchasePdf(t: TenantContext, id: string) {
  const p = await getPurchase(t, id);
  type L = (typeof p.lines)[number];
  const pdf = await pdfTable<L>({
    shopId: t.shopId,
    title: `Purchase ${p.purchaseNumber}${p.status === 'cancelled' ? ' (cancelled)' : ''}`,
    sub: `${p.supplierName} · invoice ${p.invoiceNumber} · ${day(p.invoiceDate)} · due ${day(p.dueDate)}`,
    landscape: true,
    columns: [
      { label: 'Product', get: (l) => l.productName, w: 2.6 },
      { label: 'Batch', get: (l) => l.batchNumber, w: 1.1 },
      { label: 'Exp', get: (l) => mmyy(l.expiryDate), w: 0.6 },
      { label: 'Qty', get: (l) => `${String(l.quantity)}${l.freeQuantity ? ` + ${String(l.freeQuantity)}` : ''} ${l.unit}`, num: true, w: 1.2 },
      { label: 'Rate', get: (l) => rupees(l.rate), num: true },
      { label: 'Disc', get: (l) => (l.discountPercent ? `${String(l.discountPercent)}%` : '—'), num: true, w: 0.6 },
      { label: 'MRP', get: (l) => rupees(l.mrp), num: true },
      { label: 'Taxable', get: (l) => rupees(l.taxableAmount), num: true, w: 1.1 },
      { label: 'GST', get: (l) => `${rupees(l.cgst + l.sgst)} (${String(l.gstRate)}%)`, num: true, w: 1.3 },
      { label: 'Total', get: (l) => rupees(l.totalAmount), num: true, w: 1.1 },
    ],
    rows: p.lines,
    summary: [
      ['Subtotal', rupees(p.subtotal)],
      ['Discount', rupees(-p.totalDiscount)],
      ['Taxable', rupees(p.taxableAmount)],
      ['CGST', rupees(p.cgst)],
      ['SGST', rupees(p.sgst)],
      ['Round off', rupees(p.roundOff)],
      ['= TOTAL', rupees(p.grandTotal)],
      ['Paid', rupees(p.paidAmount)],
      ['= Due', rupees(p.dueAmount)],
    ],
  });
  return { pdf, name: `Purchase-${p.purchaseNumber}` };
}

export async function ledgerPdf(t: TenantContext, id: string, from?: Date, to?: Date) {
  const l = await ledger(t, id, from, to);
  const rows: (LedgerRow | { opening: true })[] = [{ opening: true }, ...l.rows];
  const pdf = await pdfTable<(typeof rows)[number]>({
    shopId: t.shopId,
    title: `Supplier ledger · ${l.supplier.name}`,
    sub: `${day(l.from)} to ${day(l.to ?? new Date())} · balance due ${rupees(l.closing)}`,
    columns: [
      { label: 'Date', get: (r) => ('opening' in r ? day(l.from) : day(r.at)) },
      { label: 'Entry', get: (r) => ('opening' in r ? 'Opening balance' : r.kind), w: 1.1 },
      { label: 'Reference', get: (r) => ('opening' in r ? '' : r.ref), w: 2.6 },
      { label: 'Debit', get: (r) => ('opening' in r || !r.debit ? '' : rupees(r.debit)), num: true },
      { label: 'Credit', get: (r) => ('opening' in r || !r.credit ? '' : rupees(r.credit)), num: true },
      { label: 'Balance', get: (r) => rupees('opening' in r ? l.opening : r.balance), num: true },
    ],
    rows,
    foot: ['', 'Closing', '', '', '', rupees(l.closing)],
  });
  return { pdf, name: `Ledger-${l.supplier.name}` };
}

export async function reorderPdf(t: TenantContext, target: number, supplierId?: string) {
  const all = await reorder(t, target);
  const rows = supplierId ? all.filter((r) => r.lastSupplier?.id === supplierId) : all;
  const name = supplierId ? (rows[0]?.lastSupplier?.name ?? 'Supplier') : 'All suppliers';
  const pdf = await pdfTable<(typeof rows)[number]>({
    shopId: t.shopId,
    title: 'Reorder list',
    sub: `To ${name} · ${day(new Date())} · target ${String(target)} days`,
    columns: [
      { label: '#', get: (r) => rows.indexOf(r) + 1, w: 0.4 },
      { label: 'Product', get: (r) => r.name, w: 3 },
      { label: 'In stock', get: (r) => `${String(Math.floor(r.sellable / r.units.salePack))} ${r.units.sale}`, num: true, w: 1.2 },
      { label: 'Order', get: (r) => `${String(r.suggestion.saleUnits)} ${r.units.sale}`, num: true, w: 1.2 },
    ],
    rows,
  });
  return { pdf, name: `Reorder-${name}` };
}
