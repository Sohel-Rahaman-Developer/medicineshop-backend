import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const PAY_MODES = ['CASH', 'UPI', 'NEFT', 'CHEQUE'] as const;
export type PayMode = (typeof PAY_MODES)[number];
export const RETURN_REASONS = ['EXPIRY', 'NEAR_EXPIRY', 'DAMAGED', 'WRONG_ITEM'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

const lineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
    batchNumber: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    mfgDate: { type: Date },
    quantity: { type: Number, required: true },
    freeQuantity: { type: Number, required: true },
    unit: { type: String, required: true },
    /** Base units in one `unit`. */
    conv: { type: Number, required: true },
    quantityInBase: { type: Number, required: true },
    freeInBase: { type: Number, required: true },
    rate: { type: Number, required: true },
    discountPercent: { type: Number, required: true },
    grossAmount: { type: Number, required: true },
    discountAmount: { type: Number, required: true },
    taxableAmount: { type: Number, required: true },
    gstRate: { type: Number, required: true },
    cgst: { type: Number, required: true },
    sgst: { type: Number, required: true },
    igst: { type: Number, required: true, default: 0 },
    totalAmount: { type: Number, required: true },
    mrp: { type: Number, required: true },
    minPrice: { type: Number },
    landingPerUnit: { type: Number, required: true },
    costPerBaseUnit: { type: Number, required: true },
    rack: { type: String, default: '' },
    how: { type: String, enum: ['new', 'merged', 'separate'], required: true },
  },
  { _id: false },
);

// Where an invoice's paid amount came from: a payment, a return credit, or advance already with the supplier.
const allocationSchema = new Schema(
  {
    kind: { type: String, enum: ['payment', 'return', 'advance'], required: true },
    refId: { type: Schema.Types.ObjectId },
    refNumber: { type: String },
    amount: { type: Number, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const purchaseSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    purchaseNumber: { type: String, required: true },
    invoiceNumber: { type: String, required: true },
    invoiceNumberLower: { type: String, required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, required: true },
    invoiceDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    receivedDate: { type: Date, required: true },
    lines: { type: [lineSchema], required: true },
    subtotal: { type: Number, required: true },
    totalDiscount: { type: Number, required: true },
    taxableAmount: { type: Number, required: true },
    cgst: { type: Number, required: true },
    sgst: { type: Number, required: true },
    igst: { type: Number, required: true, default: 0 },
    roundOff: { type: Number, required: true },
    grandTotal: { type: Number, required: true },
    paidAmount: { type: Number, required: true, default: 0 },
    dueAmount: { type: Number, required: true },
    paymentStatus: { type: String, enum: ['paid', 'partial', 'unpaid'], required: true },
    paidAt: { type: Date },
    allocations: { type: [allocationSchema], default: [] },
    mrpChanges: { type: [new Schema({ productId: Schema.Types.ObjectId, productName: String, batchNumber: String, from: Number, to: Number }, { _id: false })], default: [] },
    status: { type: String, enum: ['active', 'cancelled'], required: true, default: 'active' },
    cancelReason: { type: String },
    cancelledBy: { type: String },
    cancelledAt: { type: Date },
    /** Paid amount that went back to the supplier's advance when this was cancelled. */
    advanceLeft: { type: Number },
    hasPhoto: { type: Boolean, required: true, default: false },
    notes: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

purchaseSchema.index({ shopId: 1, purchaseNumber: 1 }, { unique: true });
purchaseSchema.index({ shopId: 1, supplierId: 1, invoiceNumberLower: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
purchaseSchema.index({ shopId: 1, invoiceDate: -1, _id: -1 });
purchaseSchema.index({ shopId: 1, supplierId: 1, invoiceDate: -1, _id: -1 });
purchaseSchema.index({ shopId: 1, supplierId: 1, status: 1, dueAmount: 1 });
purchaseSchema.index({ shopId: 1, 'lines.productId': 1, invoiceDate: -1 });
purchaseSchema.plugin(tenantScoped);

export const PurchaseModel = model('Purchase', purchaseSchema);
export type Purchase = InferSchemaType<typeof purchaseSchema>;

const appliedSchema = new Schema(
  { purchaseId: { type: Schema.Types.ObjectId, required: true }, purchaseNumber: String, invoiceNumber: String, amount: { type: Number, required: true } },
  { _id: false },
);

// Stock back to the distributor (PLAN §13); the credit lowers what the shop owes.
const returnSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    returnNumber: { type: String, required: true },
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase' },
    purchaseNumber: { type: String },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, required: true },
    returnDate: { type: Date, required: true },
    reason: { type: String, enum: RETURN_REASONS, required: true },
    lines: {
      type: [
        new Schema(
          {
            productId: { type: Schema.Types.ObjectId, required: true },
            productName: { type: String, required: true },
            batchId: { type: Schema.Types.ObjectId, required: true },
            batchNumber: { type: String, required: true },
            expiryDate: { type: Date, required: true },
            quantity: { type: Number, required: true },
            costPerBaseUnit: { type: Number, required: true },
            gstRate: { type: Number, required: true },
            amount: { type: Number, required: true },
            tax: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      required: true,
    },
    subtotal: { type: Number, required: true },
    tax: { type: Number, required: true },
    total: { type: Number, required: true },
    applied: { type: [appliedSchema], default: [] },
    advanceAdded: { type: Number, required: true, default: 0 },
    status: { type: String, enum: ['pending', 'settled'], required: true, default: 'pending' },
    creditNoteNumber: { type: String },
    settledAt: { type: Date },
    settledBy: { type: String },
    notes: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

returnSchema.index({ shopId: 1, returnNumber: 1 }, { unique: true });
returnSchema.index({ shopId: 1, returnDate: -1, _id: -1 });
returnSchema.index({ shopId: 1, supplierId: 1, returnDate: -1 });
returnSchema.plugin(tenantScoped);

export const PurchaseReturnModel = model('PurchaseReturn', returnSchema);

// Money paid to a supplier, spread over open invoices oldest first (PLAN §21.6, §35.4).
const paymentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    paymentNumber: { type: String, required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, required: true },
    amount: { type: Number, required: true },
    applied: { type: [appliedSchema], default: [] },
    advanceAdded: { type: Number, required: true, default: 0 },
    paymentMode: { type: String, enum: PAY_MODES, required: true },
    /** Cash out of the counter drawer (day close) or the owner's own pocket. */
    fromDrawer: { type: Boolean, required: true, default: true },
    referenceNumber: { type: String, default: '' },
    paymentDate: { type: Date, required: true },
    notes: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

paymentSchema.index({ shopId: 1, paymentNumber: 1 }, { unique: true });
paymentSchema.index({ shopId: 1, supplierId: 1, paymentDate: -1 });
paymentSchema.index({ shopId: 1, paymentDate: -1 });
paymentSchema.plugin(tenantScoped);

export const SupplierPaymentModel = model('SupplierPayment', paymentSchema);
