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

/** B8c: money back through Razorpay (or recorded, for a manual payment) — each one with its own GST credit note. */
const refundSchema = new Schema({
  rzpRefundId: { type: String },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'processed', 'failed'], required: true },
  reason: { type: String, required: true },
  creditNote: { type: String },
  /** Asked to take the plan days off (a full refund always does) — kept so a refund settled later still knows. */
  removeDays: { type: Boolean, required: true, default: false },
  /** Plan days taken off for this refund; given back if the refund fails. */
  daysRemoved: { type: Number, required: true, default: 0 },
  byName: { type: String, required: true },
  at: { type: Date, required: true },
});

/** One side of a tax invoice, frozen when the invoice is made (CGST Rule 46). */
const partySchema = new Schema({ name: String, address: String, gstin: String, state: String, stateCode: String }, { _id: false });

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
    /** D80: paid while a paid plan was still running — the referral streak goes on; false starts it again. */
    continued: { type: Boolean },
    /** D80: a referral discount taken off the plan price; `amount` above is what was charged. */
    discount: { type: new Schema({ kind: { type: String, enum: ['welcome', 'reward'], required: true }, pct: { type: Number, required: true }, off: { type: Number, required: true }, listAmount: { type: Number, required: true }, referralId: { type: Schema.Types.ObjectId, required: true } }, { _id: false }) },
    invoiceNumber: { type: String },
    invoiceFrom: { type: partySchema },
    invoiceTo: { type: partySchema },
    source: { type: String, enum: ['razorpay', 'test', 'manual', 'autopay'], required: true },
    /** Autopay charges: the Razorpay subscription that took it. */
    autopayId: { type: String },
    refunds: { type: [refundSchema], default: [] },
    /** Paise refunded or on the way (failed refunds don't count). */
    refunded: { type: Number, required: true, default: 0 },
    /** A card chargeback; lost → the plan days go, like a full refund. */
    dispute: { type: new Schema({ id: String, status: String, amount: Number, reason: String, at: Date, daysRemoved: Number }, { _id: false }) },
    /** Manual (B9): the UTR / cheque number the accounts desk typed. */
    reference: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
    paidAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
paymentSchema.index({ shopId: 1, createdAt: -1 });
paymentSchema.index({ 'refunds.rzpRefundId': 1 }, { partialFilterExpression: { 'refunds.rzpRefundId': { $type: 'string' } } });
paymentSchema.index({ razorpayPaymentId: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } });
export const SubscriptionPaymentModel = model('SubscriptionPayment', paymentSchema);

export const AUTOPAY_STATUSES = ['created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed'] as const;
export type AutopayStatus = (typeof AUTOPAY_STATUSES)[number];

/** B8c: a Razorpay subscription (UPI Autopay / card mandate) that charges the plan each month or year. */
const autopaySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    planCode: { type: String, required: true },
    planName: { type: String, required: true },
    /** The price it was set up at, GST included — Razorpay charges this until it is stopped. */
    amount: { type: Number, required: true },
    durationDays: { type: Number, required: true },
    maxUsers: { type: Number, required: true },
    rzpSubscriptionId: { type: String, required: true, unique: true },
    rzpPlanId: { type: String, required: true },
    status: { type: String, enum: AUTOPAY_STATUSES, required: true, default: 'created' },
    /** Set while not cancelled / completed: the unique index keeps one per shop, even for two requests at once. */
    live: { type: Boolean },
    /** First charge on this date (a paid plan still running); none → the approval itself is the first charge. */
    startAt: { type: Date },
    chargeAt: { type: Date },
    paidCount: { type: Number, required: true, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
    stoppedAt: { type: Date },
    stopReason: { type: String },
  },
  { timestamps: true, versionKey: false },
);
autopaySchema.index({ shopId: 1, createdAt: -1 });
autopaySchema.index({ shopId: 1 }, { unique: true, partialFilterExpression: { live: true } });
export const AutopayModel = model('Autopay', autopaySchema);

/** One Razorpay plan per mode, period and price — created on first use. */
const rzpPlanSchema = new Schema({ _id: { type: String, required: true }, rzpPlanId: { type: String, required: true } }, { versionKey: false });
export const RzpPlanModel = model('RzpPlan', rzpPlanSchema);

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
