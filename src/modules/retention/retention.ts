import { Schema, Types, model } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { tenantScoped } from '../../core/tenant-scope';
import { istIsoDay } from '../../utils/date';
import { fyOf } from '../../utils/fy';
import { ExpenseModel } from '../expenses/expense.model';
import { PurchaseModel } from '../purchases/purchase.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import { MovementModel } from '../stock/movement.model';
import { ShopTermsModel } from '../subscription/terms';

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;
const TZ = 'Asia/Kolkata';

// PLAN §36.3: one line per day that stays for ever, even after a year's bill detail is removed.
const summarySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    day: { type: String, required: true },
    fy: { type: String, required: true },
    bills: { type: Number, required: true },
    sales: { type: Number, required: true },
    taxable: { type: Number, required: true },
    gst: { type: Number, required: true },
    byRate: { type: [{ _id: false, rate: Number, taxable: Number, tax: Number }], default: [] },
    cash: { type: Number, required: true },
    upi: { type: Number, required: true },
    card: { type: Number, required: true },
    udhaar: { type: Number, required: true },
    points: { type: Number, required: true },
    returns: { type: Number, required: true },
    purchases: { type: Number, required: true },
    purchaseGst: { type: Number, required: true },
    expenses: { type: Number, required: true },
  },
  { timestamps: true, versionKey: false },
);
summarySchema.index({ shopId: 1, day: 1 }, { unique: true });
summarySchema.plugin(tenantScoped);
export const DaySummaryModel = model('DaySummary', summarySchema);

const dayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);

/** The day's line, from the same bills, returns, purchases and expenses the reports use. Safe to run again. */
export async function summarise(shopId: Types.ObjectId, day: string) {
  const from = dayStart(day);
  const to = new Date(from.getTime() + DAY);
  const [[s], rates, pays, [r], [p], [e]] = await Promise.all([
    SaleModel.aggregate<{ bills: number; sales: number; taxable: number; gst: number; points: number }>([{ $match: { shopId, billDate: { $gte: from, $lt: to }, status: { $ne: 'cancelled' } } }, { $group: { _id: null, bills: { $sum: 1 }, sales: { $sum: '$grandTotal' }, taxable: { $sum: '$taxableAmount' }, gst: { $sum: '$totalTax' }, points: { $sum: { $ifNull: ['$loyaltyDiscountAmount', 0] } } } }]),
    SaleModel.aggregate<{ _id: number; taxable: number; tax: number }>([{ $match: { shopId, billDate: { $gte: from, $lt: to }, status: { $ne: 'cancelled' } } }, { $unwind: '$lines' }, { $group: { _id: '$lines.gstRate', taxable: { $sum: '$lines.taxableAmount' }, tax: { $sum: { $add: ['$lines.cgst', '$lines.sgst', '$lines.igst'] } } } }, { $sort: { _id: 1 } }]),
    SaleModel.aggregate<{ _id: string; v: number }>([{ $match: { shopId, billDate: { $gte: from, $lt: to }, status: { $ne: 'cancelled' } } }, { $unwind: '$payments' }, { $group: { _id: '$payments.mode', v: { $sum: '$payments.amount' } } }]),
    SaleReturnModel.aggregate<{ v: number }>([{ $match: { shopId, returnDate: { $gte: from, $lt: to } } }, { $group: { _id: null, v: { $sum: '$total' } } }]),
    PurchaseModel.aggregate<{ v: number; tax: number }>([{ $match: { shopId, status: 'active', invoiceDate: { $gte: from, $lt: to } } }, { $group: { _id: null, v: { $sum: '$grandTotal' }, tax: { $sum: { $add: ['$cgst', '$sgst'] } } } }]),
    ExpenseModel.aggregate<{ v: number }>([{ $match: { shopId, status: 'active', date: { $gte: from, $lt: to } } }, { $group: { _id: null, v: { $sum: '$amount' } } }]),
  ]);
  const mode = (m: string) => pays.find((x) => x._id === m)?.v ?? 0;
  const row = {
    fy: fyOf(from), bills: s?.bills ?? 0, sales: s?.sales ?? 0, taxable: s?.taxable ?? 0, gst: s?.gst ?? 0,
    byRate: rates.map((x) => ({ rate: x._id, taxable: x.taxable, tax: x.tax })),
    cash: mode('CASH'), upi: mode('UPI'), card: mode('CARD'), udhaar: mode('CREDIT'), points: s?.points ?? 0,
    returns: r?.v ?? 0, purchases: p?.v ?? 0, purchaseGst: p?.tax ?? 0, expenses: e?.v ?? 0,
  };
  await DaySummaryModel.updateOne({ shopId, day }, { $set: row }, { upsert: true });
  return row;
}

/** Nightly: yesterday and any missing day of the last week (a laptop that was off still gets its lines). */
export async function summariseRecent(shopId: Types.ObjectId, now = new Date()) {
  const have = new Set((await DaySummaryModel.find({ shopId, day: { $gte: istIsoDay(new Date(now.getTime() - 8 * DAY)) } }).select('day').lean()).map((d) => d.day));
  let n = 0;
  for (let i = 7; i >= 1; i--) {
    const day = istIsoDay(new Date(now.getTime() - i * DAY));
    if (i === 1 || !have.has(day)) {
      await summarise(shopId, day);
      n++;
    }
  }
  return n;
}

export type Tier = 'legal' | 'y10';

/** Legal minimum: the FY's GST annual return is due 31 Dec after it ends; keep 72 months more. 10 years: to the 10th 31 March. */
export function keepUntil(fy: string, tier: Tier) {
  const start = Number(fy.slice(0, 4));
  return tier === 'y10' ? new Date(Date.UTC(start + 11, 2, 31, 18, 29, 59)) : new Date(Date.UTC(start + 7, 11, 31, 18, 29, 59));
}

const fyStart = (fy: string) => new Date(Date.UTC(Number(fy.slice(0, 4)), 3, 1) - IST);
const fyEnd = (fy: string) => new Date(Date.UTC(Number(fy.slice(0, 4)) + 1, 3, 1) - IST);

/** What the shop keeps and until when (§36.3), with the 90 / 30 / 7-day notices. */
export async function plan(shopId: Types.ObjectId, now = new Date()) {
  const [terms, oldest] = await Promise.all([
    ShopTermsModel.findOne({ shopId }).lean(),
    SaleModel.findOne({ shopId }).sort({ billDate: 1 }).select('billDate').lean(),
  ]);
  const tier: Tier = terms?.retention === 'y10' ? 'y10' : 'legal';
  const fy = oldest ? fyOf(oldest.billDate) : fyOf(now);
  const until = keepUntil(fy, tier);
  const notices = [90, 30, 7].map((d) => ({ days: d, on: new Date(until.getTime() - d * DAY) }));
  return { tier, legalHold: terms?.legalHold ?? false, legalHoldReason: terms?.legalHoldReason ?? '', oldestFy: fy, oldestBill: oldest?.billDate ?? null, keepUntil: until, notices, stays: ['One line per day: bills, sales, taxable, GST (rate-wise), cash / UPI / card / udhaar / points, returns, purchases and their GST, expenses', 'Products, customers, suppliers, stock on hand, udhaar and supplier balances', 'Any bill with money still due, until it is paid'] };
}

/**
 * The deletion pass in dry run (D66): what would go for each FY past its date — never deletes. Day lines must exist and
 * match the bills first; a legal hold or a notice not yet 90 days old stops it.
 */
export async function dryRun(t: Pick<TenantContext, 'shopId'>, now = new Date()) {
  const p = await plan(t.shopId, now);
  const out = [];
  const firstFy = Number(p.oldestFy.slice(0, 4));
  for (let y = firstFy; ; y++) {
    const fy = `${String(y)}-${String((y + 1) % 100).padStart(2, '0')}`;
    if (fyStart(fy) > now) break;
    const until = keepUntil(fy, p.tier);
    const due = until <= now;
    const range = { $gte: fyStart(fy), $lt: fyEnd(fy) };
    const [bills, unpaid, purchases, returns, movements, days, [billSum], [daySum]] = await Promise.all([
      SaleModel.countDocuments({ shopId: t.shopId, billDate: range }),
      SaleModel.countDocuments({ shopId: t.shopId, billDate: range, dueAmount: { $gt: 0 } }),
      PurchaseModel.countDocuments({ shopId: t.shopId, invoiceDate: range }),
      SaleReturnModel.countDocuments({ shopId: t.shopId, returnDate: range }),
      MovementModel.countDocuments({ shopId: t.shopId, at: range }),
      SaleModel.aggregate<{ _id: string }>([{ $match: { shopId: t.shopId, billDate: range, status: { $ne: 'cancelled' } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$billDate', timezone: TZ } } } }]),
      SaleModel.aggregate<{ v: number }>([{ $match: { shopId: t.shopId, billDate: range, status: { $ne: 'cancelled' } } }, { $group: { _id: null, v: { $sum: '$grandTotal' } } }]),
      DaySummaryModel.aggregate<{ v: number; n: number }>([{ $match: { shopId: t.shopId, fy } }, { $group: { _id: null, v: { $sum: '$sales' }, n: { $sum: { $cond: [{ $gt: ['$bills', 0] }, 1, 0] } } } }]),
    ]);
    const summarised = (daySum?.n ?? 0) >= days.length && (daySum?.v ?? 0) === (billSum?.v ?? 0);
    const blocked = p.legalHold ? 'legal hold' : !due ? `kept until ${istIsoDay(until)}` : !summarised ? 'day lines missing or do not match' : null;
    out.push({ fy, keepUntil: until, due, summarised, wouldDelete: blocked ? null : { bills: bills - unpaid, purchases, returns, movements }, keptBecauseUnpaid: unpaid, blocked });
  }
  return { tier: p.tier, legalHold: p.legalHold, years: out, deletes: false };
}
