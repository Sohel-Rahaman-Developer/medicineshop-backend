import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// ADJUST_CREDIT: off this bill's own udhaar first, anything above it back in cash (PLAN §35.11). UPI: the shop sends it
// from its own phone (PhonePe, GPay — no gateway), never out of the drawer.
export const REFUND_MODES = ['CASH', 'UPI', 'CREDIT_NOTE', 'ADJUST_CREDIT'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

const lineSchema = new Schema(
  {
    lineIndex: { type: Number, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    hsn: { type: String, default: '' },
    batchId: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
    batchNumber: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    baseUnit: { type: String, required: true },
    salePack: { type: Number, required: true },
    mrp: { type: Number, required: true },
    gstRate: { type: Number, required: true },
    amount: { type: Number, required: true },
    taxable: { type: Number, required: true },
    cgst: { type: Number, required: true },
    sgst: { type: Number, required: true },
    igst: { type: Number, required: true, default: 0 },
    tax: { type: Number, required: true },
    lineCost: { type: Number, required: true },
    reason: { type: String, required: true },
    // Warning only (PLAN §15): what the item was when it came back.
    expired: { type: Boolean, required: true, default: false },
    nearExpiry: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const saleReturnSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    returnNumber: { type: String, required: true },
    creditNoteNumber: { type: String },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true },
    billNumber: { type: String, required: true },
    billDate: { type: Date, required: true },
    // Record scope (D20): a cashier sees returns on own bills.
    saleCreatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true },
    customerPhone: { type: String, default: '' },
    returnDate: { type: Date, required: true },
    reason: { type: String, required: true },
    ageDays: { type: Number, required: true },
    windowDays: { type: Number, required: true },
    outsideWindow: { type: Boolean, required: true },
    lines: { type: [lineSchema], required: true },
    taxableAmount: { type: Number, required: true },
    cgst: { type: Number, required: true },
    sgst: { type: Number, required: true },
    igst: { type: Number, required: true, default: 0 },
    totalTax: { type: Number, required: true },
    roundOff: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true },
    refundMode: { type: String, enum: REFUND_MODES, required: true },
    cashBack: { type: Number, required: true, default: 0 },
    upiBack: { type: Number, required: true, default: 0 },
    refundRef: { type: String },
    adjusted: { type: Number, required: true, default: 0 },
    // A credit note is money held for the customer, spent on later bills (an exchange) or the rest given back.
    // Absent on notes from before exchanges: their whole money value is still left.
    creditLeft: { type: Number },
    uses: {
      type: [new Schema({ saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true }, billNumber: { type: String, required: true }, amount: { type: Number, required: true }, back: { type: Number, required: true, default: 0 }, backMode: { type: String }, at: { type: Date, required: true } }, { _id: false })],
      default: undefined,
    },
    // Redeemed points go back as points, never as cash; `total` less their value is the money refund.
    loyaltyPointsRestored: { type: Number },
    loyaltyRestoredValue: { type: Number },
    loyaltyPointsReversed: { type: Number },
    totalCost: { type: Number, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

saleReturnSchema.index({ shopId: 1, returnNumber: 1 }, { unique: true });
saleReturnSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true });
saleReturnSchema.index({ shopId: 1, returnDate: -1, _id: -1 });
saleReturnSchema.index({ shopId: 1, saleCreatedBy: 1, returnDate: -1, _id: -1 });
saleReturnSchema.index({ shopId: 1, saleId: 1 });
saleReturnSchema.plugin(tenantScoped);

export const SaleReturnModel = model('SaleReturn', saleReturnSchema);
export type SaleReturn = InferSchemaType<typeof saleReturnSchema>;
