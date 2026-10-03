import { Schema, Types, model } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// PLAN §36.1: a shop's own price per plan. Cheaper starts with the next payment; dearer only after 30 days' notice,
// paying the old price until then. A paid period never changes.
const termsSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, unique: true },
    prices: { type: [{ _id: false, code: { type: String, required: true }, price: { type: Number, required: true } }], default: [] },
    /** While a rise is on notice: the prices that still apply, and when the new ones start. */
    before: { type: [{ _id: false, code: { type: String, required: true }, price: { type: Number, required: true } }], default: undefined },
    priceFrom: { type: Date },
    note: { type: String, default: '' },
    /** PLAN §36.3: how long full bill detail stays; a legal hold stops every removal. */
    retention: { type: String, enum: ['legal', 'y10'], default: 'legal' },
    legalHold: { type: Boolean, default: false },
    legalHoldReason: { type: String, default: '' },
    updatedBy: { type: String },
  },
  { timestamps: true, versionKey: false },
);
termsSchema.plugin(tenantScoped);
export const ShopTermsModel = model('ShopTerms', termsSchema);

export const NOTICE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
type Price = { code: string; price: number };

/** What this shop pays for a plan today, and a rise waiting on notice. */
export async function priceFor(shopId: Types.ObjectId, code: string, list: number, now = new Date()) {
  const t = await ShopTermsModel.findOne({ shopId }).lean();
  const own = t?.prices.find((p) => p.code === code)?.price;
  const onNotice = t?.priceFrom && t.priceFrom > now;
  const old = onNotice ? t.before?.find((p) => p.code === code)?.price : undefined;
  const price = old ?? own ?? list;
  return { price, own: own !== undefined, upcoming: onNotice && own !== undefined && own !== price ? { price: own, from: t.priceFrom ?? null } : null };
}

/** Admin sets a shop's prices (null = back to the list price). Returns what changed, for the audit. */
export async function setPrices(shopId: Types.ObjectId, input: { code: string; price: number | null }[], lists: Price[], by: string, now = new Date()) {
  const t = await ShopTermsModel.findOne({ shopId }).lean();
  const effective = async (code: string) => (await priceFor(shopId, code, lists.find((l) => l.code === code)?.price ?? 0, now)).price;
  const next: Price[] = (t?.prices ?? []).filter((p) => !input.some((i) => i.code === p.code));
  const changes: { code: string; from: number; to: number; at: 'now' | 'notice' }[] = [];
  let rise = false;
  const before: Price[] = t?.priceFrom && t.priceFrom > now ? [...(t.before ?? [])] : [];
  for (const i of input) {
    const list = lists.find((l) => l.code === i.code)?.price ?? 0;
    const to = i.price ?? list;
    const from = await effective(i.code);
    if (i.price !== null) next.push({ code: i.code, price: i.price });
    if (to === from) continue;
    if (to > from) {
      rise = true;
      if (!before.some((b) => b.code === i.code)) before.push({ code: i.code, price: from });
    } else {
      // A cut applies now, even while another rise waits.
      const k = before.findIndex((b) => b.code === i.code);
      if (k >= 0) before.splice(k, 1);
    }
    changes.push({ code: i.code, from, to, at: to > from ? 'notice' : 'now' });
  }
  // A second edit doesn't restart the 30 days (PLAN §36.1).
  const priceFrom = before.length ? (t?.priceFrom && t.priceFrom > now ? t.priceFrom : rise ? new Date(now.getTime() + NOTICE_DAYS * DAY) : undefined) : undefined;
  await ShopTermsModel.updateOne({ shopId }, { $set: { prices: next, updatedBy: by, ...(priceFrom ? { before, priceFrom } : {}) }, ...(priceFrom ? {} : { $unset: { before: 1, priceFrom: 1 } }) }, { upsert: true });
  return { changes, priceFrom: priceFrom ?? null };
}
