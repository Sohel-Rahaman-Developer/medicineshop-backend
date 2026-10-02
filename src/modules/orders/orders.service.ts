import { Types, type ClientSession } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { fyOf } from '../../utils/fy';
import { inr } from '../../utils/money';
import { salePack, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { nextNumber } from '../counters/counter.model';
import { DemandModel } from '../demands/demand.model';
import { ProductModel } from '../products/product.model';
import { can } from '../rbac/permissions';
import type { Actor } from '../user/actor';
import { OrderModel } from './order.model';
import type { CancelOrderInput, OrderInput, OrderListQuery } from './orders.validation';

const DAY = 24 * 60 * 60 * 1000;
export const STALE_DAYS = 10;
const oid = (id: string) => new Types.ObjectId(id);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type OrderLean = NonNullable<Awaited<ReturnType<typeof findOrder>>>;
const findOrder = (t: TenantContext, id: string, session?: ClientSession) => OrderModel.findOne({ shopId: t.shopId, _id: oid(id) }).session(session ?? null).lean();
type StockOf = Map<string, { sellable: number; sale: string; base: string; salePack: number }>;

async function stockOf(t: TenantContext, orders: readonly OrderLean[]): Promise<StockOf> {
  const ids = [...new Set(orders.flatMap((o) => o.items.map((i) => (i.productId ? String(i.productId) : '')).filter(Boolean)))];
  const rows = ids.length ? await ProductModel.find({ shopId: t.shopId, _id: { $in: ids.map(oid) } }).select('stock.sellable units isActive').lean() : [];
  return new Map(rows.map((p) => {
    const u = p.units as Units;
    return [String(p._id), { sellable: p.isActive ? p.stock.sellable : 0, sale: u.sale, base: u.base, salePack: salePack(u) }];
  }));
}

/** Ready is derived, never stored (PLAN §35.1): every line is a product with enough sellable stock. */
function shape(o: OrderLean, stock: StockOf, now: Date) {
  const items = o.items.map((i) => {
    const s = i.productId ? stock.get(String(i.productId)) : undefined;
    const have = s?.sellable ?? 0;
    const state = !i.productId ? 'free' : have >= i.qtyBase ? 'ok' : have > 0 ? 'short' : 'none';
    return { productId: i.productId ? String(i.productId) : null, name: i.name, qty: i.qty, unit: i.unit, qtyBase: i.qtyBase, salePack: s?.salePack ?? 1, baseUnit: s?.base ?? '', have, short: Math.max(0, i.qtyBase - have), state };
  });
  const open = o.status === 'open';
  return {
    id: String(o._id),
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    items,
    advance: o.advance,
    advanceMode: o.advanceMode ?? null,
    expectedBy: o.expectedBy ?? null,
    note: o.note,
    status: o.status,
    ready: open && items.every((i) => i.state === 'ok'),
    ageDays: Math.floor((now.getTime() - o.createdAt.getTime()) / DAY),
    saleId: o.saleId ? String(o.saleId) : null,
    billNumber: o.billNumber ?? null,
    completedAt: o.completedAt ?? null,
    advanceUsed: o.advanceUsed,
    advanceBack: o.advanceBack,
    cancelReason: o.cancelReason ?? null,
    cancelledBy: o.cancelledBy ?? null,
    cancelledAt: o.cancelledAt ?? null,
    refund: o.refund ? { amount: o.refund.amount, mode: o.refund.mode ?? 'CASH', at: o.refund.at, by: o.refund.by } : null,
    kept: o.kept ? { amount: o.kept.amount, reason: o.kept.reason, at: o.kept.at, by: o.kept.by } : null,
    createdAt: o.createdAt,
    createdByName: o.createdByName,
  };
}

export async function create(t: TenantContext, actor: Actor, input: OrderInput, ip?: string) {
  return once(t.shopId, 'order', input.clientRequestId, async (session) => {
    const now = new Date();
    const ids = input.items.flatMap((i) => (i.productId ? [i.productId] : []));
    const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: ids.map(oid) } }).select('name units').session(session).lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const items = input.items.map((i, n) => {
      if (!i.productId) return { productId: null, name: i.name, qty: i.qty, unit: '', qtyBase: 0 };
      const p = byId.get(i.productId);
      if (!p) throw AppError.validation('Product not found', [{ field: `body.items.${String(n)}.productId`, message: 'Product not found' }]);
      const u = p.units as Units;
      return { productId: p._id, name: p.name, qty: i.qty, unit: u.sale, qtyBase: i.qty * salePack(u) };
    });
    const orderNumber = await nextNumber(t.shopId, 'order', now, session);
    const [o] = await OrderModel.create(
      [
        {
          shopId: t.shopId,
          fy: fyOf(now),
          clientRequestId: input.clientRequestId,
          orderNumber,
          customerName: input.customer.name,
          customerPhone: input.customer.phone,
          items,
          advance: input.advance,
          advanceMode: input.advance ? input.advanceMode : null,
          expectedBy: input.expectedBy,
          note: input.note,
          createdBy: oid(actor.id),
          createdByName: actor.name,
        },
      ],
      { session },
    );
    if (!o) throw AppError.internal();
    if (input.demandIds.length) await DemandModel.updateMany({ shopId: t.shopId, _id: { $in: input.demandIds.map(oid) }, status: 'open' }, { $set: { status: 'ordered' } }, { session });
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'sales', entityId: String(o._id), entityName: orderNumber, text: `${actor.name} took order ${orderNumber} for ${input.customer.name} · ${String(items.length)} ${items.length === 1 ? 'item' : 'items'}${input.advance ? ` · advance ${inr(input.advance)} ${input.advanceMode ?? ''}` : ''}`, ip },
      session,
    );
    return { id: String(o._id), orderNumber, advance: input.advance };
  });
}

export async function get(t: TenantContext, id: string) {
  const o = await findOrder(t, id);
  if (!o) throw AppError.notFound('Order not found');
  return shape(o, await stockOf(t, [o]), new Date());
}

export async function list(t: TenantContext, q: OrderListQuery) {
  const now = new Date();
  const filter: Record<string, unknown> = { shopId: t.shopId, status: q.status === 'ready' ? 'open' : q.status };
  if (q.q) {
    const rx = { $regex: escape(q.q), $options: 'i' };
    filter.$or = [{ orderNumber: rx }, { customerName: rx }, { customerPhone: rx }];
  }
  // Ready is worked out from stock, so that tab reads every open order (a shop has tens, not thousands).
  if (q.status === 'ready') {
    const rows = await OrderModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(500).lean();
    const stock = await stockOf(t, rows);
    return { items: rows.map((o) => shape(o, stock, now)).filter((o) => o.ready), meta: { hasMore: false, nextCursor: null } };
  }
  const sort = { field: 'createdAt', dir: -1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await OrderModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).lean();
  const { items, meta } = page(rows, q.limit, (r) => r.createdAt);
  const stock = await stockOf(t, items);
  return { items: items.map((o) => shape(o, stock, now)), meta };
}

/** Counts for the tabs and the dashboard: open, ready to call the customer, and open too long. */
export async function summary(t: TenantContext) {
  const now = new Date();
  const rows = await OrderModel.find({ shopId: t.shopId, status: 'open' }).limit(500).lean();
  const stock = await stockOf(t, rows);
  const shaped = rows.map((o) => shape(o, stock, now));
  return { open: shaped.length, ready: shaped.filter((o) => o.ready).length, stale: shaped.filter((o) => o.ageDays > STALE_DAYS).length, advanceHeld: shaped.reduce((s, o) => s + o.advance, 0) };
}

/** A line written as a name joins the real product — only then can the order turn ready. */
export async function link(t: TenantContext, actor: Actor, id: string, index: number, productId: string, ip?: string) {
  return inTransaction(async (session) => {
    const o = await findOrder(t, id, session);
    if (!o) throw AppError.notFound('Order not found');
    const item = o.items[index];
    if (o.status !== 'open') throw AppError.conflict(`${o.orderNumber} is ${o.status}`);
    if (!item) throw AppError.validation('That line is not on the order', [{ field: 'body.index', message: 'Not on the order' }]);
    if (item.productId) throw AppError.conflict('That line is already a product');
    const p = await ProductModel.findOne({ shopId: t.shopId, _id: oid(productId) }).select('name units').session(session).lean();
    if (!p) throw AppError.notFound('Product not found');
    const u = p.units as Units;
    const k = `items.${String(index)}`;
    const done = await OrderModel.updateOne(
      { shopId: t.shopId, _id: o._id, status: 'open', [`${k}.productId`]: null },
      { $set: { [`${k}.productId`]: p._id, [`${k}.name`]: p.name, [`${k}.unit`]: u.sale, [`${k}.qtyBase`]: item.qty * salePack(u) } },
      { session },
    );
    if (!done.modifiedCount) throw AppError.conflict(`${o.orderNumber} changed meanwhile — reload`);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'sales', entityId: String(o._id), entityName: o.orderNumber, text: `${actor.name} linked “${item.name}” on ${o.orderNumber} to ${p.name}`, ip }, session);
    return { id: String(o._id), orderNumber: o.orderNumber };
  });
}

/** Cancel: the advance goes back (cash from the drawer, or UPI) or the Owner / Manager keeps it with a reason. */
export async function cancel(t: TenantContext, actor: Actor, id: string, input: CancelOrderInput, ip?: string) {
  if (input.keepReason && !can(t.permissions, 'sales', 'approve')) throw AppError.forbidden('Only the Owner or Manager can keep an advance.');
  return inTransaction(async (session) => {
    const now = new Date();
    const o = await findOrder(t, id, session);
    if (!o) throw AppError.notFound('Order not found');
    if (o.status !== 'open') throw AppError.conflict(`${o.orderNumber} is already ${o.status}`);
    if (o.advance && input.keepReason !== undefined && input.keepReason.length < 3) throw AppError.validation('Say why the shop keeps the advance', [{ field: 'body.keepReason', message: 'A reason is required' }]);
    const keep = Boolean(o.advance && input.keepReason);
    const money = o.advance
      ? keep
        ? { kept: { amount: o.advance, reason: input.keepReason ?? '', by: actor.name, at: now } }
        : { refund: { amount: o.advance, mode: input.refundMode ?? 'CASH', reason: input.reason, by: actor.name, at: now } }
      : {};
    const done = await OrderModel.updateOne({ shopId: t.shopId, _id: o._id, status: 'open' }, { $set: { status: 'cancelled', cancelReason: input.reason, cancelledBy: actor.name, cancelledAt: now, ...money } }, { session });
    if (!done.modifiedCount) throw AppError.conflict(`${o.orderNumber} changed meanwhile — reload`);
    const what = !o.advance ? '' : keep ? ` · advance ${inr(o.advance)} kept: ${input.keepReason ?? ''}` : ` · advance ${inr(o.advance)} given back ${input.refundMode ?? 'CASH'}`;
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'cancel', module: 'sales', entityId: String(o._id), entityName: o.orderNumber, text: `${actor.name} cancelled order ${o.orderNumber} · ${input.reason}${what}`, ip }, session);
    return { id: String(o._id), orderNumber: o.orderNumber, kept: keep, refunded: o.advance && !keep ? o.advance : 0 };
  });
}

/** Billing an order (sales.create): open, and the advance that comes off this bill. */
export async function forBill(t: TenantContext, id: string, session: ClientSession) {
  const o = await findOrder(t, id, session);
  if (!o) throw AppError.notFound('Order not found');
  if (o.status !== 'open') throw AppError.conflict(`${o.orderNumber} is already ${o.status}`);
  return o;
}

export async function complete(t: TenantContext, o: OrderLean, sale: { id: Types.ObjectId; billNumber: string; at: Date; advanceUsed: number }, session: ClientSession) {
  const done = await OrderModel.updateOne(
    { shopId: t.shopId, _id: o._id, status: 'open' },
    { $set: { status: 'completed', saleId: sale.id, billNumber: sale.billNumber, completedAt: sale.at, advanceUsed: sale.advanceUsed, advanceBack: o.advance - sale.advanceUsed } },
    { session },
  );
  if (!done.modifiedCount) throw AppError.conflict(`${o.orderNumber} was billed or cancelled meanwhile — reload`);
}
