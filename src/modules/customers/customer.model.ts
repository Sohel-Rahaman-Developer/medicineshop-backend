import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// PLAN §16 customer master: every field now so later phases add no migration. Phone is the shop's key for a person.
const customerSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true, default: '' },
    dob: { type: Date, default: null },
    gender: { type: String, enum: ['', 'female', 'male', 'other'], default: '' },
    address: { type: String, trim: true, default: '' },
    // B2B buyer (PLAN §35.10): printed on the bill.
    gstin: { type: String, trim: true, uppercase: true, default: '' },
    businessName: { type: String, trim: true, default: '' },
    whatsappOptIn: { type: Boolean, default: false },
    smsOptIn: { type: Boolean, default: false },
    emailOptIn: { type: Boolean, default: false },
    totalSpend: { type: Number, required: true, default: 0 },
    visitCount: { type: Number, required: true, default: 0 },
    firstVisit: { type: Date, default: null },
    lastVisit: { type: Date, default: null },
    /** Udhaar in paise: credit bills still open, rewritten in the same transaction as the bill / payment / return. */
    creditBalance: { type: Number, required: true, default: 0 },
    /** 0 = no udhaar for this customer (sandbox rule). */
    creditLimit: { type: Number, required: true, default: 0 },
    loyaltyPoints: { type: Number, required: true, default: 0 },
    lifetimePointsEarned: { type: Number, required: true, default: 0 },
    lifetimePointsRedeemed: { type: Number, required: true, default: 0 },
    tier: { type: String, default: '' },
    chronicConditions: { type: [String], default: [] },
    notes: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['active', 'blocked'], required: true, default: 'active' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: 'version', minimize: false },
);

customerSchema.index({ shopId: 1, phone: 1 }, { unique: true });
customerSchema.index({ shopId: 1, nameLower: 1 });
customerSchema.index({ shopId: 1, creditBalance: -1, _id: -1 });
customerSchema.index({ shopId: 1, lastVisit: -1, _id: -1 });
customerSchema.plugin(tenantScoped);

export const CustomerModel = model('Customer', customerSchema);
export type Customer = InferSchemaType<typeof customerSchema>;

// Udhaar collected (PLAN §22): spread over the customer's open credit bills, oldest first.
const appliedSchema = new Schema({ saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true }, billNumber: { type: String, required: true }, amount: { type: Number, required: true } }, { _id: false });

export const COLLECT_MODES = ['CASH', 'UPI', 'CARD'] as const;

const paymentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    receiptNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    amount: { type: Number, required: true },
    applied: { type: [appliedSchema], default: [] },
    paymentMode: { type: String, enum: COLLECT_MODES, required: true },
    reference: { type: String, default: '' },
    paymentDate: { type: Date, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

paymentSchema.index({ shopId: 1, receiptNumber: 1 }, { unique: true });
paymentSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true });
paymentSchema.index({ shopId: 1, customerId: 1, paymentDate: -1 });
paymentSchema.index({ shopId: 1, paymentDate: -1 });
paymentSchema.plugin(tenantScoped);

export const CustomerPaymentModel = model('CustomerPayment', paymentSchema);

// The prescriber on an H1 / X bill (PLAN §14); a shop keeps its own list.
const doctorSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true },
    specialization: { type: String, trim: true, default: '' },
    registrationNumber: { type: String, trim: true, default: '' },
    phone: { type: String, default: '' },
    clinic: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, required: true, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);

doctorSchema.index({ shopId: 1, nameLower: 1 }, { unique: true });
doctorSchema.plugin(tenantScoped);

export const DoctorModel = model('Doctor', doctorSchema);
