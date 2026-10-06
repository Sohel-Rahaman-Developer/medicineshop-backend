import { Schema, model, type InferSchemaType } from 'mongoose';

// D80: one shop brings another. Cross-shop on purpose (referrer and referee are two tenants), so not tenant-scoped;
// every shop-facing query names its own shop id.

const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'referral' },
    enabled: { type: Boolean, required: true, default: true },
    /** The new shop's discount on its first payment, made within `newShopDays` of joining. */
    newShopPct: { type: Number, required: true, default: 10 },
    newShopDays: { type: Number, required: true, default: 30 },
    /** The referrer's discount on one payment, once the new shop has paid `qualifyMonths` without a break. */
    rewardPct: { type: Number, required: true, default: 10 },
    qualifyMonths: { type: Number, required: true, default: 3 },
    updatedBy: { type: String },
  },
  { timestamps: true, versionKey: false },
);
export const ReferralSettingsModel = model('ReferralSettings', settingsSchema);

/** One per referred shop. The terms are frozen when it is made, so a later settings change never moves a promise. */
const referralSchema = new Schema(
  {
    referrerShopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    refereeShopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, unique: true },
    source: { type: String, enum: ['signup', 'admin'], required: true },
    code: { type: String, required: true },
    newShopPct: { type: Number, required: true },
    newShopUntil: { type: Date, required: true },
    rewardPct: { type: Number, required: true },
    qualifyDays: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'qualified'], required: true, default: 'pending' },
    /** Paid days in a row so far (yearly counts as 365). */
    streakDays: { type: Number, required: true, default: 0 },
    qualifiedAt: { type: Date },
    welcomePaymentId: { type: Schema.Types.ObjectId },
    reward: { type: String, enum: ['none', 'ready', 'used'], required: true, default: 'none' },
    rewardPaymentId: { type: Schema.Types.ObjectId },
    rewardUsedAt: { type: Date },
    setBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
referralSchema.index({ referrerShopId: 1, createdAt: -1 });
referralSchema.index({ referrerShopId: 1, reward: 1, qualifiedAt: 1 });
export const ReferralModel = model('Referral', referralSchema);
export type Referral = InferSchemaType<typeof referralSchema>;
