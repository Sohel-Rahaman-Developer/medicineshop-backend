import { Schema, model, type ClientSession, type Types } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';
import { fyOf } from '../../utils/fy';

const counterSchema = new Schema(
  {
    _id: { type: String, required: true },
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);
counterSchema.plugin(tenantScoped);

export const CounterModel = model('Counter', counterSchema);

const KINDS = { adjustment: ['ADJ', 4], purchase: ['PUR', 4], purchaseReturn: ['PR', 4], supplierPayment: ['PAY', 4], sale: ['INV', 5] } as const satisfies Record<string, readonly [string, number]>;
export type CounterKind = keyof typeof KINDS;

/** Atomic per-shop, per-FY number — never count()+1 (PLAN §26): ADJ-2026-27-0001. */
export async function nextNumber(shopId: Types.ObjectId, kind: CounterKind, at: Date, session: ClientSession, prefixOverride?: string): Promise<string> {
  const fy = fyOf(at);
  const doc = await CounterModel.findOneAndUpdate(
    { _id: `${String(shopId)}:${kind}:${fy}`, shopId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  const [prefix, pad] = KINDS[kind];
  return `${prefixOverride || prefix}-${fy}-${String(doc.seq).padStart(pad, '0')}`;
}
