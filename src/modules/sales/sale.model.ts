import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// CREDIT = udhaar: needs a customer with a limit (PLAN §14, §16).
export const SALE_PAY_MODES = ['CASH', 'UPI', 'CARD', 'CREDIT'] as const;
export type SalePayMode = (typeof SALE_PAY_MODES)[number];
// ADVANCE is an order's advance coming off its bill (PLAN §35.1); the server adds it, the client never sends it.
const STORED_MODES = [...SALE_PAY_MODES, 'ADVANCE'] as const;

// One line per batch: a cart line that spans two batches is two bill lines, each at its own MRP (PLAN §14).
const lineSchema = new Schema(
  {
    item: { type: Number, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    category: { type: String, default: '' },
    hsn: { type: String, default: '' },
    schedule: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
    batchNumber: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    quantityInBase: { type: Number, required: true },
    unit: { type: String, required: true },
    baseUnit: { type: String, required: true },
    salePack: { type: Number, required: true },
    mrp: { type: Number, required: true },
    gross: { type: Number, required: true },
    lineDiscount: { type: Number, required: true },
    billDiscountShare: { type: Number, required: true },
    discountAmount: { type: Number, required: true },
    typedPrice: { type: Boolean, required: true, default: false },
    aboveMrpAmount: { type: Number, required: true, default: 0 },
    minPrice: { type: Number },
    belowMinPrice: { type: Boolean, required: true, default: false },
    gstRate: { type: Number, required: true },
    taxableAmount: { type: Number, required: true },
    cgst: { type: Number, required: true },
    sgst: { type: Number, required: true },
    igst: { type: Number, required: true, default: 0 },
    totalAmount: { type: Number, required: true },
    costPerBaseUnit: { type: Number, required: true },
    lineCost: { type: Number, required: true },
    lineProfit: { type: Number, required: true },
    returnedQuantity: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const paymentSchema = new Schema({ mode: { type: String, enum: STORED_MODES, required: true }, amount: { type: Number, required: true }, reference: { type: String, default: '' } }, { _id: false });

const saleSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    billNumber: { type: String, required: true },
    billDate: { type: Date, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true, default: 'Walk-in' },
    customerPhone: { type: String, default: '' },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor' },
    doctorName: { type: String, default: '' },
    patientName: { type: String, default: '' },
    rxNumber: { type: String, default: '' },
    rxDate: { type: Date },
    orderId: { type: Schema.Types.ObjectId, ref: 'CustomerOrder' },
    orderNumber: { type: String },
    lines: { type: [lineSchema], required: true },
    subtotal: { type: Number, required: true },
    lineDiscountAmount: { type: Number, required: true },
    billDiscountAmount: { type: Number, required: true },
    totalDiscount: { type: Number, required: true },
    discountPercent: { type: Number, required: true },
    // D43: limit is a snapshot of the setting at billing time, for the discount register.
    discountAboveLimit: { type: Boolean, required: true },
    discountLimitPercent: { type: Number, required: true },
    aboveMrpAmount: { type: Number, required: true, default: 0 },
    belowMinPrice: { type: Boolean, required: true, default: false },
    taxableAmount: { type: Number, required: true },
    cgst: { type: Number, required: true },
    sgst: { type: Number, required: true },
    igst: { type: Number, required: true, default: 0 },
    totalTax: { type: Number, required: true },
    roundOff: { type: Number, required: true },
    grandTotal: { type: Number, required: true },
    toPay: { type: Number, required: true },
    payments: { type: [paymentSchema], default: [] },
    paymentMode: { type: String, enum: [...STORED_MODES, 'SPLIT', 'NONE'], required: true },
    cashReceived: { type: Number },
    paidAmount: { type: Number, required: true },
    dueAmount: { type: Number, required: true, default: 0 },
    paymentStatus: { type: String, enum: ['paid', 'partial', 'credit'], required: true },
    totalCost: { type: Number, required: true },
    grossProfit: { type: Number, required: true },
    status: { type: String, enum: ['completed', 'partially_returned', 'returned', 'cancelled'], required: true, default: 'completed' },
    cancelReason: { type: String },
    cancelledBy: { type: String },
    cancelledAt: { type: Date },
    // Udhaar still open when the bill was cancelled — the customer's statement credits it back.
    cancelledDue: { type: Number },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

saleSchema.index({ shopId: 1, billNumber: 1 }, { unique: true });
saleSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true });
saleSchema.index({ shopId: 1, billDate: -1, _id: -1 });
saleSchema.index({ shopId: 1, createdBy: 1, billDate: -1, _id: -1 });
saleSchema.index({ shopId: 1, discountAboveLimit: 1, billDate: -1 }, { partialFilterExpression: { discountAboveLimit: true } });
saleSchema.index({ shopId: 1, 'lines.batchId': 1 });
saleSchema.index({ shopId: 1, fy: 1 });
saleSchema.index({ shopId: 1, customerId: 1, billDate: -1 });
saleSchema.index({ shopId: 1, customerId: 1, dueAmount: 1 }, { partialFilterExpression: { dueAmount: { $gt: 0 } } });
saleSchema.plugin(tenantScoped);

export const SaleModel = model('Sale', saleSchema);
export type Sale = InferSchemaType<typeof saleSchema>;
