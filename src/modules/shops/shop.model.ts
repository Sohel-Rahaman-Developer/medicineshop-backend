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
    },
    inventory: {
      defaultReorderLevel: { type: Number, default: 10 },
      expiryAlertDays: { type: [Number], default: [90, 60, 30] },
      autoFefo: { type: Boolean, default: true },
      allowBatchOverride: { type: Boolean, default: true },
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
