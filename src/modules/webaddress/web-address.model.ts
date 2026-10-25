import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// D94: a shop's own address, <slug>.medbox24.in. requested → active (admin approves) or rejected; stopped by the admin;
// released when another shop takes a name that lapsed 60 days ago.
export const ADDRESS_STATUSES = ['requested', 'active', 'rejected', 'stopped', 'released'] as const;
export type AddressStatus = (typeof ADDRESS_STATUSES)[number];

const webAddressSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    slug: { type: String, required: true },
    status: { type: String, enum: ADDRESS_STATUSES, required: true },
    requestedAt: { type: Date, required: true },
    requestedByName: { type: String, required: true },
    decidedAt: { type: Date },
    decidedByName: { type: String },
    reason: { type: String, default: '' },
    // Free after the trial until this day (admin's gift); paid time comes with the add-on payment (v1.24.1).
    freeUntil: { type: Date },
    paidUntil: { type: Date },
    notes: { type: [new Schema({ text: { type: String, required: true }, byName: { type: String, required: true }, at: { type: Date, required: true } }, { _id: false })], default: [] },
  },
  { timestamps: true, versionKey: false },
);

// One open address per shop; a name belongs to one shop at a time (released ones keep their history).
webAddressSchema.index({ shopId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['requested', 'active', 'stopped'] } } });
webAddressSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['requested', 'active', 'stopped'] } } });
webAddressSchema.index({ status: 1, requestedAt: -1 });
webAddressSchema.plugin(tenantScoped);

export type WebAddress = InferSchemaType<typeof webAddressSchema>;
export const WebAddressModel = model('WebAddress', webAddressSchema);

export const ADDRESS_PERIODS = ['month', 'year'] as const;
export type AddressPeriod = (typeof ADDRESS_PERIODS)[number];

const partySchema = new Schema({ name: String, address: String, gstin: String, state: String, stateCode: String }, { _id: false });

// v1.24.1: the add-on paid through Razorpay or by hand. The webhook finds it by order id, so it is not tenant-scoped
// (like SubscriptionPayment); every shop-facing query still filters by shopId.
const paymentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    addressId: { type: Schema.Types.ObjectId, ref: 'WebAddress', required: true },
    slug: { type: String, required: true },
    period: { type: String, enum: ADDRESS_PERIODS, required: true },
    days: { type: Number, required: true },
    /** Paise, GST included; `gst` is the 18% inside it. */
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
    invoiceFrom: { type: partySchema },
    invoiceTo: { type: partySchema },
    source: { type: String, enum: ['razorpay', 'test', 'manual'], required: true },
    /** Manual: the UTR / receipt the accounts desk typed. */
    reference: { type: String },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    createdByName: { type: String, required: true },
    paidAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
paymentSchema.index({ shopId: 1, createdAt: -1 });
paymentSchema.index({ razorpayPaymentId: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } });
export const WebAddressPaymentModel = model('WebAddressPayment', paymentSchema);
