import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// One lot of a product: its own expiry, MRP and cost. Stock lives here, in base units (PLAN §9).
const batchSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    batchNumber: { type: String, required: true, trim: true },
    batchNumberUpper: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    mfgDate: { type: Date },
    /** Paise per sale unit — the price printed on the pack. */
    mrp: { type: Number, required: true },
    /** Paise per purchaseUnit, before GST. */
    purchaseRate: { type: Number, required: true },
    purchaseUnit: { type: String, required: true },
    /** Base units in one sale unit, copied from the product; it can't change once stock exists. */
    salePack: { type: Number, required: true },
    costPerBaseUnit: { type: Number, required: true },
    quantity: { type: Number, required: true, default: 0 },
    initialQuantity: { type: Number, required: true },
    freeQuantity: { type: Number, required: true, default: 0 },
    rack: { type: String, uppercase: true, trim: true, default: '' },
    source: { type: String, enum: ['opening', 'purchase'], required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase' },
    purchaseInvoiceNumber: { type: String },
    status: { type: String, enum: ['active', 'blocked', 'returned'], required: true, default: 'active' },
    blockedAt: { type: Date },
    blockReason: { type: String },
    receivedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

batchSchema.index({ shopId: 1, productId: 1, expiryDate: 1 });
batchSchema.index({ shopId: 1, productId: 1, batchNumberUpper: 1, expiryDate: 1 });
batchSchema.index({ shopId: 1, expiryDate: 1, status: 1 });
batchSchema.index({ shopId: 1, rack: 1 });
batchSchema.plugin(tenantScoped);

export const BatchModel = model('Batch', batchSchema);
export type Batch = InferSchemaType<typeof batchSchema>;
export type BatchDoc = InstanceType<typeof BatchModel>;
