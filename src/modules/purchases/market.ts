import { Types, type ClientSession } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import type { Actor } from '../user/actor';
import { SupplierModel } from '../suppliers/supplier.model';
import { codeOf } from '../suppliers/suppliers.service';

export const MARKET_NAME = 'Market / local shop';

/** Stock bought for cash from the market, a wholesaler or another shop: one such "supplier" per shop, made the first time. */
export async function marketSupplier(t: TenantContext, actor: Actor, session?: ClientSession) {
  const found = await SupplierModel.findOne({ shopId: t.shopId, market: true }).select('name').session(session ?? null).lean();
  if (found) return { id: String(found._id), name: found.name };
  const made = await SupplierModel.findOneAndUpdate(
    { shopId: t.shopId, market: true },
    { $setOnInsert: { shopId: t.shopId, market: true, name: MARKET_NAME, nameLower: MARKET_NAME.toLowerCase(), code: codeOf(MARKET_NAME), phone: '—', creditDays: 0, notes: 'Cash buys from the market, a wholesaler or another shop', createdBy: new Types.ObjectId(actor.id), createdByName: actor.name } },
    { upsert: true, returnDocument: 'after', session: session ?? null },
  ).lean();
  return { id: String(made._id), name: made.name };
}
