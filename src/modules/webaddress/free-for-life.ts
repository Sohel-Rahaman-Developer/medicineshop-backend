import type { Types } from 'mongoose';
import { OwnDomainModel } from '../owndomain/own-domain.model';
import { FreeForLifeModel, WebAddressModel } from './web-address.model';

export const FREE_FOR_LIFE = 50;
const ALL = { crossTenant: true } as const;

/** True when the shop's add-on is free for life: it already is, or the shop takes one of the first 50 places now. */
export async function claimFreeForLife(shopId: Types.ObjectId, now = new Date()): Promise<boolean> {
  // The unique rank keeps two approvals at the same moment from making a 51st place.
  for (let i = 0; i < 5; i++) {
    if (await FreeForLifeModel.exists({ _id: shopId })) return true;
    const rank = (await FreeForLifeModel.countDocuments({})) + 1;
    if (rank > FREE_FOR_LIFE) return false;
    try {
      await FreeForLifeModel.create({ _id: shopId, rank, at: now });
      return true;
    } catch {
      // Another shop took this rank (or this shop got in meanwhile); look again.
    }
  }
  return FreeForLifeModel.exists({ _id: shopId }).then(Boolean);
}

export async function freeForLifeLeft(): Promise<number> {
  return Math.max(0, FREE_FOR_LIFE - (await FreeForLifeModel.countDocuments({})));
}

/** Approved or switched on: the record says free for life when the shop holds a place (taking one if any is left). */
export async function markFreeForLife(kind: 'address' | 'domain', id: Types.ObjectId, shopId: Types.ObjectId, now = new Date()): Promise<boolean> {
  if (!(await claimFreeForLife(shopId, now))) return false;
  if (kind === 'address') await WebAddressModel.updateOne({ _id: id, shopId }, { $set: { freeForLife: true } });
  else await OwnDomainModel.updateOne({ _id: id, shopId }, { $set: { freeForLife: true } });
  return true;
}

/** Once at start: addresses and domains already live before the offer take their places in the order they were approved. */
export async function backfillFreeForLife(): Promise<number> {
  const [a, d] = await Promise.all([
    WebAddressModel.find({ status: 'active', freeForLife: { $ne: true } }, null, ALL).select('shopId decidedAt').lean(),
    OwnDomainModel.find({ status: 'active', freeForLife: { $ne: true } }, null, ALL).select('shopId decidedAt').lean(),
  ]);
  const rows = [...a.map((r) => ({ ...r, on: 'address' as const })), ...d.map((r) => ({ ...r, on: 'domain' as const }))].sort((x, y) => (x.decidedAt?.getTime() ?? 0) - (y.decidedAt?.getTime() ?? 0));
  let marked = 0;
  for (const r of rows) if (await markFreeForLife(r.on, r._id, r.shopId, r.decidedAt ?? new Date())) marked++;
  return marked;
}
