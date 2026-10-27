import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { fyOf } from '../../utils/fy';
import { CategoryModel } from '../categories/category.model';
import { CounterModel } from '../counters/counter.model';
import { ProductModel } from '../products/product.model';
import { seesCost } from '../products/products.service';
import { BatchModel } from '../stock/batch.model';
import type { Actor } from '../user/actor';
import { PosDeviceModel } from './pos-device.model';
import { create, POS_FIELDS, posItem, posSettings, SALE_BATCH, type SaleBatch } from './sales.service';
import type { OfflineSaleInput, SaleInput } from './sales.validation';

// D104: billing with no internet. A counter registers once (online) for its own bill series, keeps a copy of what it
// sells, bills offline, and sends each bill when the line is back — once, never twice (clientRequestId).

/** How old an offline bill may be when it arrives, and how far a counter's clock may run ahead. */
export const OFFLINE_DAYS = 60;
const AHEAD_MS = 10 * 60 * 1000;

/** This browser's counter: the same random key always gets the same code (OFL1, OFL2 …) and its last number this year. */
export async function registerDevice(t: TenantContext, actor: Actor, input: { key: string; name: string }) {
  const fy = fyOf(new Date());
  const shape = (d: { _id: Types.ObjectId; code: string; name?: string; seqs: { fy: string; seq: number }[] }) => ({ id: String(d._id), code: d.code, name: d.name ?? '', fy, seq: d.seqs.find((s) => s.fy === fy)?.seq ?? 0 });
  const found = await PosDeviceModel.findOne({ shopId: t.shopId, key: input.key }).lean();
  if (found) return shape(found);
  const n = await CounterModel.findOneAndUpdate({ _id: `${String(t.shopId)}:posDevice`, shopId: t.shopId }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  try {
    const [doc] = await PosDeviceModel.create([{ shopId: t.shopId, key: input.key, code: `OFL${String(n.seq)}`, name: input.name, createdBy: new Types.ObjectId(actor.id), createdByName: actor.name }]);
    if (!doc) throw AppError.internal();
    return shape(doc.toObject());
  } catch (e) {
    // Two tabs registering at once: the other one won, use it.
    if ((e as { code?: number }).code !== 11000) throw e;
    const again = await PosDeviceModel.findOne({ shopId: t.shopId, key: input.key }).lean();
    if (!again) throw e;
    return shape(again);
  }
}

/** Everything the counter may sell, as POS search shows it, plus barcodes — kept on the device for offline billing. */
export async function catalog(t: TenantContext) {
  const now = new Date();
  const [products, batches, categories, settings] = await Promise.all([
    ProductModel.find({ shopId: t.shopId, isActive: true }).select(`${POS_FIELDS} barcode altBarcodes`).lean(),
    BatchModel.find({ shopId: t.shopId, status: 'active', quantity: { $gt: 0 }, expiryDate: { $gte: now } }).select(SALE_BATCH).lean<SaleBatch[]>(),
    CategoryModel.find({ shopId: t.shopId }).select('name').lean(),
    posSettings(t),
  ]);
  const byProduct = new Map<string, SaleBatch[]>();
  for (const b of batches) byProduct.set(String(b.productId), [...(byProduct.get(String(b.productId)) ?? []), b]);
  const cats = new Map(categories.map((c) => [String(c._id), c.name]));
  const cost = seesCost(t);
  const items = products.map((p) => ({ ...posItem(p, byProduct.get(String(p._id)) ?? [], cats, now, cost), codes: [p.barcode, ...(p.altBarcodes ?? [])].filter((c): c is string => Boolean(c)) }));
  return { at: now, settings, items };
}

/** An offline bill arriving: on the counter's own number, dated when it was sold, refused for nothing the cashier could fix now. */
export async function createOffline(t: TenantContext, actor: Actor, input: OfflineSaleInput, ip?: string) {
  const device = await PosDeviceModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(input.deviceId) }).lean();
  if (!device) throw AppError.notFound('This counter is not set up for offline bills — open the counter once with the internet on');
  const now = Date.now();
  if (input.soldAt.getTime() > now + AHEAD_MS) throw AppError.validation('This bill is dated in the future — check the date and time on this device');
  if (input.soldAt.getTime() < now - OFFLINE_DAYS * 86_400_000) throw AppError.validation(`This offline bill is more than ${String(OFFLINE_DAYS)} days old — ask the owner to enter it by hand`);
  const sale: SaleInput = { clientRequestId: input.clientRequestId, items: input.items, customer: input.customer, rx: input.rx, customerId: input.customerId, payments: input.payments, cashReceived: input.cashReceived, redeemPoints: 0 };
  let out: Awaited<ReturnType<typeof create>>;
  try {
    out = await create(t, actor, sale, ip, { deviceId: device._id, code: device.code, seq: input.seq, soldAt: input.soldAt });
  } catch (e) {
    if ((e as { code?: number; keyPattern?: Record<string, unknown> }).code === 11000 && (e as { keyPattern?: Record<string, unknown> }).keyPattern?.billNumber) {
      const number = `${device.code}-${fyOf(input.soldAt)}-${String(input.seq).padStart(4, '0')}`;
      throw AppError.conflict(`Bill number ${number} is already used by another bill`, { reason: 'NUMBER_USED' });
    }
    throw e;
  }
  // The last number this counter used this year: a cleared browser carries on after it, never re-uses one.
  const fy = fyOf(input.soldAt);
  const seqs = device.seqs.filter((s) => s.fy !== fy);
  const last = Math.max(input.seq, device.seqs.find((s) => s.fy === fy)?.seq ?? 0);
  await PosDeviceModel.updateOne({ shopId: t.shopId, _id: device._id }, { $set: { lastSyncAt: new Date(), seqs: [...seqs, { fy, seq: last }] } });
  return out;
}
