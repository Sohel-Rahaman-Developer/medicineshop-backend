import { Schema, model, type InferSchemaType } from 'mongoose';

// v1.25.1: stock sent from one shop of a group to another. It belongs to two shops, so it is not tenant-scoped; every
// query names fromShopId or toShopId. Same GSTIN → delivery challan (no tax); another GSTIN → tax invoice at cost.
export const TRANSFER_STATUSES = ['sent', 'received', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

const partySchema = new Schema({ name: String, address: String, gstin: String, state: String, stateCode: String, drugLicense: String }, { _id: false });

const lineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, required: true },
    productName: { type: String, required: true },
    hsnCode: { type: String, default: '' },
    gstRate: { type: Number, required: true },
    base: { type: String, required: true },
    sale: { type: String, required: true },
    salePack: { type: Number, required: true },
    batchId: { type: Schema.Types.ObjectId, required: true },
    batchNumber: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    mrp: { type: Number, required: true },
    purchaseRate: { type: Number, required: true },
    purchaseUnit: { type: String, required: true },
    costPerBaseUnit: { type: Number, required: true },
    /** Base units. */
    quantity: { type: Number, required: true },
    /** Paise: quantity × cost — the taxable value on an invoice. */
    value: { type: Number, required: true },
    tax: { type: Number, required: true, default: 0 },
    /** Where it landed in the receiving shop. */
    toProductId: { type: Schema.Types.ObjectId },
    toBatchNumber: { type: String },
  },
  { _id: false },
);

const transferSchema = new Schema(
  {
    fromShopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    toShopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    number: { type: String, required: true },
    kind: { type: String, enum: ['challan', 'invoice'], required: true },
    status: { type: String, enum: TRANSFER_STATUSES, required: true, default: 'sent' },
    lines: { type: [lineSchema], required: true },
    value: { type: Number, required: true },
    tax: { type: Number, required: true },
    total: { type: Number, required: true },
    from: { type: partySchema, required: true },
    to: { type: partySchema, required: true },
    note: { type: String, default: '' },
    sentByName: { type: String, required: true },
    sentAt: { type: Date, required: true },
    receivedByName: { type: String },
    receivedAt: { type: Date },
    cancelledByName: { type: String },
    cancelledAt: { type: Date },
    cancelReason: { type: String },
  },
  { timestamps: true, versionKey: false },
);
transferSchema.index({ fromShopId: 1, sentAt: -1 });
transferSchema.index({ toShopId: 1, status: 1, sentAt: -1 });

export type StockTransfer = InferSchemaType<typeof transferSchema>;
export const StockTransferModel = model('StockTransfer', transferSchema);
