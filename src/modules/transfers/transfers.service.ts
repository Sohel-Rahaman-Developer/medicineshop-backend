import { Types } from 'mongoose';
import { day, rupees } from '../../core/export';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import { invoicePdf } from '../../core/invoice-pdf';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { monthLabel } from '../../utils/date';
import { rhu } from '../../utils/money';
import { fromBase, salePack, toUnits, type Units } from '../../utils/units';
import { rupeesInWords } from '../../utils/words';
import { audit } from '../audit/audit.model';
import { groupShops } from '../branches/branches.service';
import { CategoryModel } from '../categories/category.model';
import { nextNumber } from '../counters/counter.model';
import { emit } from '../notifications/notifications.service';
import { ProductModel, type Product } from '../products/product.model';
import { logoBytes } from '../shops/shop-logo';
import { BatchModel } from '../stock/batch.model';
import { applyMove, refreshRollups } from '../stock/stock.ledger';
import { receiveBatch } from '../stock/stock.service';
import type { Actor } from '../user/actor';
import { StockTransferModel, type StockTransfer } from './transfer.model';

// v1.25.1: stock leaves the sending shop at once (in transit) and lands in the other shop when it presses Receive.
// Same GSTIN → delivery challan, no tax; another GSTIN → tax invoice valued at cost. Cancelled before receipt → back.

const oid = (id: string) => new Types.ObjectId(id);

type Shop = Awaited<ReturnType<typeof groupShops>>[number];
const party = (s: Shop) => {
  const a = s.address;
  return { name: s.name, address: a ? [a.line1, a.line2, a.city, `${a.state} ${a.pincode}`].filter(Boolean).join(', ') : '', gstin: s.gstin ?? '', state: a?.state ?? '', stateCode: a?.stateCode ?? '', drugLicense: s.drugLicenseNumber };
};
/** No GSTIN on the sender, or the same GSTIN both sides: a challan. Otherwise a sale between two GST registrations. */
const kindOf = (from: Shop, to: Shop) => (from.gstin && from.gstin !== to.gstin ? 'invoice' : 'challan');

/** The other shops of the group this shop can send to, and which paper each one gets. */
export async function targets(t: TenantContext) {
  const shops = await groupShops(t.shopId);
  const here = shops.find((s) => s._id.equals(t.shopId));
  if (!here) return [];
  return shops.filter((s) => !s._id.equals(t.shopId)).map((s) => ({ id: String(s._id), name: s.name, city: s.address?.city ?? '', gstin: s.gstin ?? '', kind: kindOf(here, s) }));
}

export interface SendInput {
  clientRequestId: string;
  toShopId: string;
  lines: { batchId: string; quantity: number }[];
  note?: string;
}

export async function send(t: TenantContext, actor: Actor, input: SendInput, ip?: string) {
  const ids = input.lines.map((l) => l.batchId);
  if (new Set(ids).size !== ids.length) throw AppError.validation('A batch is in the list twice', [{ field: 'body.lines', message: 'A batch is in the list twice' }]);
  const shops = await groupShops(t.shopId);
  const from = shops.find((s) => s._id.equals(t.shopId));
  const to = shops.find((s) => String(s._id) === input.toShopId && !s._id.equals(t.shopId));
  if (!from || !to) throw AppError.validation('Choose one of your other shops', [{ field: 'body.toShopId', message: 'Choose one of your other shops' }]);
  const out = await once(t.shopId, 'transfer', input.clientRequestId, async (session) => {
    const now = new Date();
    const batches = await BatchModel.find({ shopId: t.shopId, _id: { $in: ids.map(oid) } }).session(session).lean();
    if (batches.length !== ids.length) throw AppError.notFound('One of the batches was not found');
    const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: batches.map((b) => b.productId) } }).select('name hsnCode gstRate units').session(session).lean();
    const kind = kindOf(from, to);
    const id = new Types.ObjectId();
    const number = await nextNumber(t.shopId, 'transfer', now, session);
    const lines = [];
    for (const l of input.lines) {
      const b = batches.find((x) => String(x._id) === l.batchId);
      const p = products.find((x) => b && x._id.equals(b.productId));
      if (!b || !p) throw AppError.notFound('Batch not found');
      if (b.status === 'blocked') throw AppError.conflict(`Batch ${b.batchNumber} is blocked — it can’t be sent`);
      if (b.status !== 'active') throw AppError.conflict(`Batch ${b.batchNumber} went back to the supplier`);
      if (b.expiryDate.getTime() < now.getTime()) throw AppError.conflict(`Batch ${b.batchNumber} has expired — it can’t be sent`);
      const units = p.units as Units;
      const left = fromBase(b.quantity, units);
      if (l.quantity > b.quantity) throw AppError.conflict(`Only ${left} left in batch ${b.batchNumber}`);
      const value = l.quantity * b.costPerBaseUnit;
      lines.push({ productId: p._id, productName: p.name, hsnCode: p.hsnCode, gstRate: p.gstRate, base: units.base, sale: units.sale, salePack: salePack(units), batchId: b._id, batchNumber: b.batchNumber, expiryDate: b.expiryDate, mrp: b.mrp, purchaseRate: b.purchaseRate, purchaseUnit: b.purchaseUnit, costPerBaseUnit: b.costPerBaseUnit, quantity: l.quantity, value, tax: kind === 'invoice' ? rhu(value * p.gstRate, 100) : 0 });
      await applyMove(t.shopId, b._id, -l.quantity, { type: 'TRANSFER_OUT', refType: 'TRANSFER', refId: id, refNumber: number, reason: `To ${to.name}`, actor, at: now }, session);
    }
    const value = lines.reduce((s, l) => s + l.value, 0);
    const tax = lines.reduce((s, l) => s + l.tax, 0);
    await StockTransferModel.create([{ _id: id, fromShopId: from._id, toShopId: to._id, number, kind, status: 'sent', lines, value, tax, total: value + tax, from: party(from), to: party(to), note: input.note ?? '', sentByName: actor.name, sentAt: now }], { session });
    await refreshRollups(t.shopId, [...new Set(batches.map((b) => String(b.productId)))].map(oid), session, now);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'stock', entityId: String(id), entityName: number, text: `${actor.name} sent ${number} to ${to.name} — ${String(lines.length)} ${lines.length === 1 ? 'batch' : 'batches'}, ${rupees(value)} at cost${tax ? ` + GST ${rupees(tax)}` : ''}`, ip }, session);
    await emit(to._id, { key: `TRANSFER:${String(id)}`, type: 'STOCK_TRANSFER', priority: 'medium', title: transferTitle(from.name, lines.length), body: `${number}. Press Receive when it reaches you — the stock is added then.`, route: '/transfers', perm: { module: 'stock', action: 'edit' } }, session);
    return { id: String(id), number, kind, lines: lines.length, value, tax, total: value + tax };
  });
  return out.result;
}

const transferTitle = (from: string, n: number) => (n === 1 ? `1 medicine coming from ${from}` : `${String(n)} medicines coming from ${from}`);

type Row = StockTransfer & { _id: Types.ObjectId };
const rowsOf = (filter: Record<string, unknown>) => StockTransferModel.find(filter).sort({ sentAt: -1 }).limit(50).lean<Row[]>();
const shape = (r: Row, here: Types.ObjectId) => ({
  id: String(r._id),
  number: r.number,
  kind: r.kind,
  status: r.status,
  incoming: r.toShopId.equals(here),
  from: r.from.name ?? '',
  to: r.to.name ?? '',
  value: r.value,
  tax: r.tax,
  total: r.total,
  note: r.note,
  sentAt: r.sentAt,
  sentByName: r.sentByName,
  receivedAt: r.receivedAt ?? null,
  receivedByName: r.receivedByName ?? null,
  cancelledAt: r.cancelledAt ?? null,
  cancelReason: r.cancelReason ?? null,
  lines: r.lines.map((l) => ({ productName: l.productName, batchNumber: l.toBatchNumber ?? l.batchNumber, expiryDate: l.expiryDate, quantity: l.quantity, units: { base: l.base, sale: l.sale, salePack: l.salePack }, mrp: l.mrp, value: l.value })),
});

/** Transfers this shop sent or is to receive, newest first; incoming waiting ones on top. */
export async function list(t: TenantContext) {
  const [incoming, outgoing, to] = await Promise.all([rowsOf({ toShopId: t.shopId }), rowsOf({ fromShopId: t.shopId }), targets(t)]);
  return { incoming: incoming.map((r) => shape(r, t.shopId)), outgoing: outgoing.map((r) => shape(r, t.shopId)), shops: to };
}

/** The receiving shop takes the stock in: same batch, expiry, MRP and cost; a medicine it doesn't have yet is added. */
export async function receive(t: TenantContext, actor: Actor, id: string, ip?: string) {
  const out = await inTransaction(async (session) => {
    const now = new Date();
    const tr = await StockTransferModel.findOne({ _id: oid(id), toShopId: t.shopId }).session(session);
    if (!tr) throw AppError.notFound('Transfer not found');
    if (tr.status !== 'sent') throw AppError.conflict(tr.status === 'received' ? 'Already received' : 'The sender cancelled this transfer');
    const srcProducts = await ProductModel.find({ shopId: tr.fromShopId, _id: { $in: tr.lines.map((l) => l.productId) } }).session(session).lean();
    const productIds: Types.ObjectId[] = [];
    for (const l of tr.lines) {
      const src = srcProducts.find((p) => p._id.equals(l.productId));
      if (!src) throw AppError.conflict(`${l.productName} was deleted in the sending shop`);
      const p = (await ProductModel.findOne({ shopId: t.shopId, nameLower: src.nameLower }).session(session).lean()) ?? (await copyProduct(src, t.shopId, actor, session));
      if (!p.isActive) await ProductModel.updateOne({ shopId: t.shopId, _id: p._id }, { $set: { isActive: true } }, { session });
      const r = await receiveBatch(
        t.shopId,
        p,
        { batchNumber: l.batchNumber, expiry: l.expiryDate, mrp: l.mrp, rack: '', mrpChoice: 'separate' },
        { source: 'transfer', quantity: l.quantity, freeQuantity: 0, purchaseRate: l.purchaseRate, purchaseUnit: l.purchaseUnit, costPerBaseUnit: l.costPerBaseUnit, transferId: tr._id, invoiceNumber: tr.number, refNumber: tr.number },
        actor,
        session,
        now,
      );
      l.toProductId = p._id;
      l.toBatchNumber = r.batchNumber;
      productIds.push(p._id);
    }
    tr.set({ status: 'received', receivedByName: actor.name, receivedAt: now });
    await tr.save({ session });
    await refreshRollups(t.shopId, productIds, session, now);
    const text = `${actor.name} received ${tr.number} from ${tr.from.name ?? ''} — ${String(tr.lines.length)} ${tr.lines.length === 1 ? 'batch' : 'batches'}`;
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'stock', entityId: String(tr._id), entityName: tr.number, text, ip }, session);
    await audit({ shopId: tr.fromShopId, userId: actor.id, userName: actor.name, action: 'update', module: 'stock', entityId: String(tr._id), entityName: tr.number, text: `${tr.to.name ?? ''}: ${text}`, ip }, session);
    return tr.toObject();
  });
  return shape(out, t.shopId);
}

type SrcProduct = Omit<Product, 'photo'> & { _id: Types.ObjectId };

/** The sender's medicine, without stock, into the receiving shop — its category found by name, or added. */
async function copyProduct(src: SrcProduct, shopId: Types.ObjectId, actor: Actor, session: Parameters<typeof receiveBatch>[5]) {
  const cat = await CategoryModel.findOne({ shopId: src.shopId, _id: src.categoryId }).session(session).lean();
  if (!cat) throw AppError.conflict(`${src.name} has no category in the sending shop`);
  const mine = (await CategoryModel.findOne({ shopId, key: cat.key }).session(session).lean()) ?? (await CategoryModel.create([{ shopId, name: cat.name, key: cat.key, isSystem: cat.isSystem }], { session }))[0];
  if (!mine) throw AppError.internal();
  const [p] = await ProductModel.create(
    [{ shopId, name: src.name, nameLower: src.nameLower, searchKey: src.searchKey, company: src.company, salt: src.salt, saltKey: src.saltKey, strength: src.strength, categoryId: mine._id, scheduleType: src.scheduleType, storageType: src.storageType, hsnCode: src.hsnCode, gstRate: src.gstRate, units: src.units, packSize: src.packSize, noExpiry: src.noExpiry, reorderLevel: src.reorderLevel, reorderQuantity: src.reorderQuantity, isActive: true, createdBy: oid(actor.id), createdByName: actor.name }],
    { session },
  );
  if (!p) throw AppError.internal();
  return p.toObject();
}

/** The sender takes it back before it was received: the stock returns to the same batches. */
export async function cancel(t: TenantContext, actor: Actor, id: string, reason: string, ip?: string) {
  const out = await inTransaction(async (session) => {
    const now = new Date();
    const tr = await StockTransferModel.findOne({ _id: oid(id), fromShopId: t.shopId }).session(session);
    if (!tr) throw AppError.notFound('Transfer not found');
    if (tr.status !== 'sent') throw AppError.conflict(tr.status === 'received' ? 'Already received — it can’t be cancelled' : 'Already cancelled');
    for (const l of tr.lines) await applyMove(t.shopId, l.batchId, l.quantity, { type: 'TRANSFER_CANCEL', refType: 'TRANSFER', refId: tr._id, refNumber: tr.number, reason, actor, at: now }, session);
    tr.set({ status: 'cancelled', cancelledByName: actor.name, cancelledAt: now, cancelReason: reason });
    await tr.save({ session });
    await refreshRollups(t.shopId, [...new Set(tr.lines.map((l) => String(l.productId)))].map(oid), session, now);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'cancel', module: 'stock', entityId: String(tr._id), entityName: tr.number, text: `${actor.name} cancelled ${tr.number} to ${tr.to.name ?? ''} — ${reason}`, ip }, session);
    return tr.toObject();
  });
  return shape(out, t.shopId);
}

/** The paper that travels with the stock: a delivery challan, or a tax invoice between two GSTINs. */
export async function pdf(t: TenantContext, id: string) {
  const tr = await StockTransferModel.findOne({ _id: oid(id), $or: [{ fromShopId: t.shopId }, { toShopId: t.shopId }] }).lean();
  if (!tr) throw AppError.notFound('Transfer not found');
  const invoice = tr.kind === 'invoice';
  const intra = tr.from.stateCode === tr.to.stateCode;
  const cgst = Math.floor(tr.tax / 2);
  const buf = await invoicePdf({
    size: 'A4',
    title: invoice ? 'TAX INVOICE' : 'DELIVERY CHALLAN',
    meta: [[invoice ? 'Invoice no.' : 'Challan no.', tr.number], ['Date', day(tr.sentAt)], ['Place of supply', `${tr.to.state ?? ''} (${tr.to.stateCode ?? ''})`], invoice ? ['Reverse charge', 'No'] : ['Reason', 'Stock transfer']],
    ...(tr.status === 'cancelled' ? { stamp: 'CANCELLED' } : {}),
    logoImage: await logoBytes(tr.fromShopId),
    issuer: { name: tr.from.name ?? '', lines: [tr.from.address ?? '', [tr.from.gstin ? `GSTIN ${tr.from.gstin}` : 'Unregistered', tr.from.drugLicense ? `DL ${tr.from.drugLicense}` : ''].filter(Boolean).join(' · ')] },
    parties: [{ label: 'Sent to', lines: [tr.to.name ?? '', tr.to.address ?? '', [tr.to.gstin ? `GSTIN ${tr.to.gstin}` : 'Unregistered', tr.to.drugLicense ? `DL ${tr.to.drugLicense}` : ''].filter(Boolean).join(' · ')] }],
    columns: [{ label: '#', w: 0.4 }, { label: 'Medicine', w: 3.4 }, { label: 'HSN', w: 1 }, { label: 'Qty', w: 1.3, num: true }, { label: 'Value', w: 1.2, num: true }, { label: 'GST', w: 0.7, num: true }, { label: 'Amount', w: 1.2, num: true }],
    rows: tr.lines.map((l, i) => ({
      cells: [String(i + 1), l.productName, l.hsnCode || '—', fromBase(l.quantity, toUnits({ type: 'COUNT', base: l.base, sale: l.sale, salePack: l.salePack, purchase: l.sale, purchasePack: 1, allowLooseSale: true })), rupees(l.value), invoice ? `${String(l.gstRate)}%` : '—', rupees(l.value + l.tax)],
      sub: `Batch ${l.batchNumber} · exp ${monthLabel(l.expiryDate)} · MRP ${rupees(l.mrp)}`,
    })),
    totals: invoice
      ? [{ label: 'Taxable value (at cost)', value: rupees(tr.value) }, ...(intra ? [{ label: 'CGST', value: rupees(cgst) }, { label: 'SGST', value: rupees(tr.tax - cgst) }] : [{ label: 'IGST', value: rupees(tr.tax) }]), { label: 'Total', value: rupees(tr.total), strong: true }]
      : [{ label: 'Value at cost', value: rupees(tr.value), strong: true }],
    words: rupeesInWords(tr.total),
    notes: [
      invoice ? 'Supply between two GST registrations of the same business, valued at cost.' : 'Goods moved between places of business of the same GSTIN — not a sale, no tax charged (CGST Rule 55).',
      ...(tr.note ? [tr.note] : []),
      tr.status === 'received' && tr.receivedAt ? `Received by ${tr.receivedByName ?? ''} on ${day(tr.receivedAt)}` : '',
    ].filter(Boolean),
    footer: `Computer-generated — no signature needed · ${tr.from.name ?? ''}`,
  });
  return { buf, name: tr.number };
}
