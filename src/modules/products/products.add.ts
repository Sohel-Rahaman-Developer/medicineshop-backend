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
import { insertProduct, prepareProduct } from './products.service';
import type { CreateProductInput, FirstStockInput } from './products.validation';

/** Add product with its first batch: both or neither. A retry with the same request id returns the first result. */
export async function addWithStock(t: TenantContext, actor: Actor, input: CreateProductInput & { stock: FirstStockInput }, ip?: string) {
  if (!can(t.permissions, 'stock', 'create')) throw AppError.forbidden('You can add the product, but not its stock — save it without a batch');
  const now = new Date();
  const lot = lotOf({ noExpiry: input.noExpiry, scheduleType: input.scheduleType }, input.stock.batchNumber, input.stock.expiry, istYmd(now));
  if ('field' in lot) throw AppError.validation(lot.message, [{ field: `body.stock.${lot.field}`, message: lot.message }]);
  const photo = await prepareProduct(t, input);
  const { result } = await once(t.shopId, 'product-add', input.stock.clientRequestId, async (session) => {
    const p = await insertProduct(t, actor, input, photo, session, ip);
    const stock = input.stock;
    const out = await receiveOpening(t.shopId, p, { ...lot, quantity: stock.quantity, mrp: stock.mrp, purchaseRate: stock.purchaseRate, rack: stock.rack }, actor, session, now);
    await refreshRollups(t.shopId, [p._id], session, now);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'stock', entityId: out.batchId, entityName: `${p.name} · ${out.batchNumber}`, text: `${actor.name} added opening stock: ${fromBase(stock.quantity, p.units as Units)} of ${p.name}, batch ${out.batchNumber}`, ip },
      session,
    );
    return { id: String(p._id), batchId: out.batchId, batchNumber: out.batchNumber };
  });
  return result;
}
