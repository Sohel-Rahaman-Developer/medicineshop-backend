import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const ADVANCE_MODES = ['CASH', 'UPI'] as const;
export type AdvanceMode = (typeof ADVANCE_MODES)[number];

// A line is a product, or only a name until the product is linked (PLAN §35.1); qty is in sale units.
const itemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, required: true },
    qty: { type: Number, required: true },
    unit: { type: String, default: '' },
    qtyBase: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const moneyEvent = new Schema({ amount: { type: Number, required: true }, mode: { type: String }, reason: { type: String, default: '' }, by: { type: String, required: true }, at: { type: Date, required: true } }, { _id: false });

const orderSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    orderNumber: { type: String, required: true },
    customerName: { type: String, required: true },
    customerPhone: { type: String, default: '' },
    items: { type: [itemSchema], required: true },
    advance: { type: Number, required: true, default: 0 },
    advanceMode: { type: String, enum: [...ADVANCE_MODES, null], default: null },
    expectedBy: { type: Date },
    note: { type: String, default: '' },
    status: { type: String, enum: ['open', 'completed', 'cancelled'], required: true, default: 'open' },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    billNumber: { type: String },
    completedAt: { type: Date },
    // Billed: the advance that came off the bill, and any extra handed back in cash.
    advanceUsed: { type: Number, default: 0 },
    advanceBack: { type: Number, default: 0 },
    cancelReason: { type: String },
    cancelledBy: { type: String },
    cancelledAt: { type: Date },
    refund: { type: moneyEvent },
    kept: { type: moneyEvent },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

orderSchema.index({ shopId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true });
orderSchema.index({ shopId: 1, status: 1, createdAt: -1, _id: -1 });
orderSchema.plugin(tenantScoped);

export const OrderModel = model('CustomerOrder', orderSchema);
export type CustomerOrder = InferSchemaType<typeof orderSchema>;
