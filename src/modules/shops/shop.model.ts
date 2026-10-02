import { Schema, model, type InferSchemaType } from 'mongoose';

// PLAN §24 defaults; each phase adds its own section when it ships.
const settingsSchema = new Schema(
  {
    general: {
      businessDayStartHour: { type: Number, default: 0, min: 0, max: 23 },
      lowStockCheckEnabled: { type: Boolean, default: true },
    },
    tax: {
      pricingMode: { type: String, enum: ['MRP_INCLUSIVE', 'EXCLUSIVE'], default: 'MRP_INCLUSIVE' },
      defaultGstRate: { type: Number, default: 12 },
      enableIgst: { type: Boolean, default: false },
      showHsnOnBill: { type: Boolean, default: true },
    },
    billing: {
      billPrefix: { type: String, default: 'INV' },
      roundOffEnabled: { type: Boolean, default: true },
      allowNegativeStock: { type: Boolean, default: false },
      maxDiscountPercent: { type: Number, default: 20 },
      enforceH1Prescription: { type: Boolean, default: true },
      saleReturnWindowDays: { type: Number, default: 7 },
      // Cash in the drawer before the first day close (PLAN §35.3); later the last close's leftover.
      openingFloat: { type: Number, default: 0 },
    },
    inventory: {
      defaultReorderLevel: { type: Number, default: 10 },
      expiryAlertDays: { type: [Number], default: [90, 60, 30] },
      autoFefo: { type: Boolean, default: true },
      allowBatchOverride: { type: Boolean, default: true },
    },
    // PLAN §16. A new shop starts with points off until the owner says what a point is worth (sandbox).
    loyalty: {
      enabled: { type: Boolean, default: false },
      configured: { type: Boolean, default: false },
      earnRate: { type: Number, default: 1 },
      earnPerAmount: { type: Number, default: 10_000 },
      minBillForEarning: { type: Number, default: 0 },
      excludedCategories: { type: [String], default: [] },
      earnOnDiscountedAmount: { type: Boolean, default: true },
      pointValue: { type: Number, default: 100 },
      minPointsToRedeem: { type: Number, default: 100 },
      maxRedeemPercent: { type: Number, default: 20 },
      redeemMultipleOf: { type: Number, default: 10 },
      pointExpiryMonths: { type: Number, default: 12 },
      expiryWarningDays: { type: Number, default: 30 },
      tiers: {
        type: [new Schema({ name: { type: String, required: true }, minLifetimePoints: { type: Number, required: true }, earnMultiplier: { type: Number, required: true } }, { _id: false })],
        default: () => [
          { name: 'Silver', minLifetimePoints: 0, earnMultiplier: 1 },
          { name: 'Gold', minLifetimePoints: 1000, earnMultiplier: 1.25 },
          { name: 'Platinum', minLifetimePoints: 5000, earnMultiplier: 1.5 },
        ],
      },
      birthdayBonusPoints: { type: Number, default: 100 },
      signupBonusPoints: { type: Number, default: 50 },
    },
    notifications: {
      dailySummaryTime: { type: String, default: '22:00' },
      alertDigestTime: { type: String, default: '08:00' },
      emailEnabled: { type: Boolean, default: true },
    },
  },
  { _id: false },
);

const shopSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    legalName: { type: String, required: true, trim: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    address: {
      line1: { type: String, required: true, trim: true },
      line2: { type: String, trim: true, default: '' },
      city: { type: String, required: true, trim: true },
      state: { type: String, required: true, trim: true },
      stateCode: { type: String, required: true },
      pincode: { type: String, required: true },
    },
    phone: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true },
    gstin: { type: String, uppercase: true, trim: true },
    pan: { type: String, uppercase: true, trim: true },
    drugLicenseNumber: { type: String, required: true, trim: true },
    drugLicenseExpiry: { type: Date, required: true },
    fssai: { type: String, trim: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    currency: { type: String, default: 'INR' },
    financialYearStartMonth: { type: Number, default: 4 },
    status: { type: String, enum: ['active', 'suspended', 'closed'], default: 'active', required: true },
    suspendReason: { type: String },
    settings: { type: settingsSchema, default: () => ({}) },
  },
  { timestamps: true, versionKey: 'version', optimisticConcurrency: true },
);

shopSchema.index({ gstin: 1 }, { sparse: true });

export const ShopModel = model('Shop', shopSchema);
export type Shop = InferSchemaType<typeof shopSchema>;
export type ShopDoc = InstanceType<typeof ShopModel>;
