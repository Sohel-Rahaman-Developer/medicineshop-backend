import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { istYmd } from '../../utils/date';
import { fromBase, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { can } from '../rbac/permissions';
import { lotOf } from '../stock/stock.domain';
import { refreshRollups } from '../stock/stock.ledger';
import { receiveOpening } from '../stock/stock.service';
import type { Actor } from '../user/actor';
import { assertFloor, insertProduct, prepareProduct } from './products.service';
import type { CreateProductInput, FirstStockInput } from './products.validation';

/** Add product with its batches on the shelf: all or nothing. A retry with the same request id returns the first result. */
export async function addWithStock(t: TenantContext, actor: Actor, input: CreateProductInput & { stock: FirstStockInput }, ip?: string) {
  if (!can(t.permissions, 'stock', 'create')) throw AppError.forbidden('You can add the product, but not its stock — save it without a batch');
  const now = new Date();
  const all = [input.stock, ...(input.moreStock ?? [])];
  const lots = all.map((s, i) => {
    const at = i ? `body.moreStock.${String(i - 1)}` : 'body.stock';
    const lot = lotOf({ noExpiry: input.noExpiry, scheduleType: input.scheduleType }, s.batchNumber, s.expiry, istYmd(now));
    if ('field' in lot) throw AppError.validation(lot.message, [{ field: `${at}.${lot.field}`, message: lot.message }]);
    assertFloor(input.sellPrice, s.minPrice, `${at}.minPrice`);
    return { ...lot, quantity: s.quantity, mrp: s.mrp, purchaseRate: s.purchaseRate, rack: s.rack, minPrice: s.minPrice ?? null };
  });
  const photo = await prepareProduct(t, input);
  const { result } = await once(t.shopId, 'product-add', input.stock.clientRequestId, async (session) => {
    const p = await insertProduct(t, actor, input, photo, session, ip);
    const outs = [];
    for (const lot of lots) {
      // The same batch number typed twice with another MRP stays a batch of its own.
      const out = await receiveOpening(t.shopId, p, { ...lot, mrpChoice: 'separate' }, actor, session, now);
      outs.push(out);
      await audit(
        { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'stock', entityId: out.batchId, entityName: `${p.name} · ${out.batchNumber}`, text: `${actor.name} added opening stock: ${fromBase(lot.quantity, p.units as Units)} of ${p.name}, batch ${out.batchNumber}`, ip },
        session,
      );
    }
    await refreshRollups(t.shopId, [p._id], session, now);
    const first = outs[0];
    if (!first) throw AppError.internal();
    return { id: String(p._id), batchId: first.batchId, batchNumber: first.batchNumber, batches: outs.length };
  });
  return result;
}
