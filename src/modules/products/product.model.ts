import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';
import { UNIT_TYPES } from '../../utils/units';
import { STORAGE_TYPES } from '../racks/rack.model';
import { NO_EXPIRY } from '../stock/stock.domain';

export const SCHEDULE_TYPES = ['OTC', 'H', 'H1', 'X', 'NON_DRUG'] as const;
export const GST_RATES = [0, 5, 12, 18, 28, 40] as const;

// Rollup of the product's batches (PLAN §21.4). Rewritten in the same transaction as every movement.
const stockSchema = new Schema(
  {
    onHand: { type: Number, default: 0 },
    sellable: { type: Number, default: 0 },
    expired: { type: Number, default: 0 },
    blocked: { type: Number, default: 0 },
    value: { type: Number, default: 0 },
    mrpValue: { type: Number, default: 0 },
    batches: { type: Number, default: 0 },
    nextExpiry: { type: Date, default: null },
    expirySort: { type: Date, default: NO_EXPIRY },
    validUntil: { type: Date, default: NO_EXPIRY },
    status: { type: String, enum: ['ok', 'low', 'out'], default: 'out' },
    /** Bumped on every rewrite, so a background refresh never overwrites a newer rollup. */
    rev: { type: Number, default: 0 },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true },
    /** Normalised name + salt + company, searched by word start. */
    searchKey: { type: String, required: true },
    company: { type: String, trim: true, default: '' },
    salt: { type: String, trim: true, default: '' },
    saltKey: { type: String, default: '' },
    strength: { type: String, trim: true, default: '' },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    scheduleType: { type: String, enum: SCHEDULE_TYPES, required: true, default: 'OTC' },
    storageType: { type: String, enum: STORAGE_TYPES, required: true, default: 'NORMAL' },
    hsnCode: { type: String, trim: true, default: '' },
    gstRate: { type: Number, enum: GST_RATES, required: true },
    barcode: { type: String, trim: true },
    units: {
      type: { type: String, enum: UNIT_TYPES, required: true },
      base: { type: String, required: true },
      sale: { type: String, required: true },
      purchase: { type: String, required: true },
      conversions: { type: Schema.Types.Mixed, required: true },
      allowLooseSale: { type: Boolean, required: true, default: false },
    },
    packSize: { type: String, trim: true, default: '' },
    /** D59: BP machines, thermometers — batches carry NO_EXPIRY. Fixed once stock exists. */
    noExpiry: { type: Boolean, required: true, default: false },
    defaultRack: { type: String, uppercase: true, trim: true, default: '' },
    reorderLevel: { type: Number, required: true, default: 0 },
    reorderQuantity: { type: Number, required: true, default: 0 },
    /** 96 × 96 WebP re-encoded on the server, at most 3 KB (D41, D48). */
    photo: {
      type: new Schema({ data: { type: Buffer, required: true }, bytes: { type: Number, required: true }, updatedAt: { type: Date, required: true } }, { _id: false }),
      default: null,
    },
    stock: { type: stockSchema, default: () => ({}) },
    lastMrp: { type: Number },
    lastSoldAt: { type: Date },
    isActive: { type: Boolean, required: true, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: 'version', optimisticConcurrency: true, minimize: false },
);

productSchema.index({ shopId: 1, nameLower: 1 }, { unique: true });
productSchema.index({ shopId: 1, isActive: 1, nameLower: 1 });
productSchema.index({ shopId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } });
productSchema.index({ shopId: 1, categoryId: 1 });
productSchema.index({ shopId: 1, saltKey: 1 });
productSchema.index({ shopId: 1, isActive: 1, 'stock.status': 1, nameLower: 1 });
productSchema.index({ shopId: 1, isActive: 1, 'stock.expirySort': 1 });
productSchema.index({ shopId: 1, 'stock.validUntil': 1 });
productSchema.plugin(tenantScoped);

export const ProductModel = model('Product', productSchema);
export type Product = InferSchemaType<typeof productSchema>;
export type ProductDoc = InstanceType<typeof ProductModel>;
