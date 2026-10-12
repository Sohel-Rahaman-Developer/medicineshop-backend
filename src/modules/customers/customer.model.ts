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
    /** Udhaar from before MedBox24 (the old khata) still unpaid — part of creditBalance, collected first. */
    oldDue: { type: Number, required: true, default: 0 },
    oldDueSince: { type: Date, default: null },
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
    /** Paid towards the old khata udhaar, before any bill. */
    fromOld: { type: Number, default: 0 },
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

// D90: one weekly sitting — day 0 = Sunday, "19:00"–"21:00", at most `max` patients.
const sittingSchema = new Schema({ day: { type: Number, required: true, min: 0, max: 6 }, start: { type: String, required: true }, end: { type: String, required: true }, max: { type: Number, required: true } }, { _id: false });
const chamberSchema = new Schema(
  {
    /** Fee per visit in paise; the money is the doctor's, the shop keeps its commission. */
    fee: { type: Number, required: true, default: 0 },
    /** A visit within this many days of the last one with this doctor is a free follow-up (0 = never). */
    freeDays: { type: Number, required: true, default: 0 },
    commission: { mode: { type: String, enum: ['pct', 'flat'], required: true, default: 'pct' }, value: { type: Number, required: true, default: 0 } },
    /** Minutes per patient, for the time a token can expect. */
    minutes: { type: Number, required: true, default: 10 },
    sittings: { type: [sittingSchema], default: [] },
  },
  { _id: false },
);

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
    /** D90: when and for how much the doctor sits at the shop (Pro). */
    chamber: { type: chamberSchema, default: undefined },
    isActive: { type: Boolean, required: true, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);

doctorSchema.index({ shopId: 1, nameLower: 1 }, { unique: true });
doctorSchema.plugin(tenantScoped);

export const DoctorModel = model('Doctor', doctorSchema);

// Old khata udhaar written in (or corrected): the statement's "Old balance" lines.
const oldUdhaarSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    /** Paise; negative = a correction. */
    amount: { type: Number, required: true },
    since: { type: Date, required: true },
    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
oldUdhaarSchema.index({ shopId: 1, customerId: 1, since: 1 });
oldUdhaarSchema.plugin(tenantScoped);

export const OldUdhaarModel = model('CustomerOldUdhaar', oldUdhaarSchema);
