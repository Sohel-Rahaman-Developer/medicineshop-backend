import { Schema, model, type InferSchemaType } from 'mongoose';

// Platform-side records (PLAN §21.10). Payments carry shopId, but the webhook finds them by order id — so they are
// not tenant-scoped; every shop-facing query still filters by shopId.

const planSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    /** Paise, GST included. */
    price: { type: Number, required: true },
    durationDays: { type: Number, required: true },
    maxUsers: { type: Number, required: true },
    isActive: { type: Boolean, required: true, default: true },
    sortOrder: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
export const PlanModel = model('Plan', planSchema);
export type Plan = InferSchemaType<typeof planSchema>;

/** Placeholder list prices (PLAN §8) — the admin app changes them later (B9). */
export const DEFAULT_PLANS = [
  { code: 'monthly', name: 'Monthly', price: 79_900, durationDays: 30, maxUsers: 5, sortOrder: 1 },
  { code: 'yearly', name: 'Yearly', price: 799_000, durationDays: 365, maxUsers: 10, sortOrder: 2 },
];

const paymentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    planCode: { type: String, required: true },
    planName: { type: String, required: true },
    durationDays: { type: Number, required: true },
    maxUsers: { type: Number, required: true },
    /** Snapshot at order time, GST included; `gst` is the 18% inside it. */
    amount: { type: Number, required: true },
    gst: { type: Number, required: true },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String },
    method: { type: String },
    status: { type: String, enum: ['created', 'paid', 'failed'], required: true, default: 'created' },
    failureReason: { type: String },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    invoiceNumber: { type: String },
    source: { type: String, enum: ['razorpay', 'test', 'manual'], required: true },
    /** Manual (B9): the UTR / cheque number the accounts desk typed. */
    reference: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
    paidAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
paymentSchema.index({ shopId: 1, createdAt: -1 });
paymentSchema.index({ razorpayPaymentId: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } });
export const SubscriptionPaymentModel = model('SubscriptionPayment', paymentSchema);

const webhookSchema = new Schema(
  {
    provider: { type: String, required: true, default: 'razorpay' },
    eventId: { type: String, required: true, unique: true },
    // Not `type`: Mongoose reads that key as the field's own type.
    event: { type: String, required: true },
    signatureValid: { type: Boolean, required: true },
    result: { type: String, required: true },
    payloadHash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
export const WebhookEventModel = model('WebhookEvent', webhookSchema);

/** Platform invoice numbers run across every shop, one series per financial year. */
const counterSchema = new Schema({ _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } }, { versionKey: false });
export const PlatformCounterModel = model('PlatformCounter', counterSchema);
