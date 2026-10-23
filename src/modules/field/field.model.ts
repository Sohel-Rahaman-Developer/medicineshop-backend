import { Schema, model } from 'mongoose';

// D100: MedBox24's field staff — not console admins. Each has a code that gives a new shop the longer trial, signs in
// with a password or an email code (no authenticator), and can fill a shop's details for its owner to confirm.

const staffSchema = new Schema(
  {
    /** Empty until the staff member adds it; the email shows meanwhile. */
    name: { type: String, default: '', trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: '' },
    /** Upper-case letters and digits, as typed in the onboarding code box. */
    code: { type: String, required: true, unique: true },
    status: { type: String, enum: ['active', 'disabled'], required: true, default: 'active' },
    passwordHash: { type: String },
    failedLogins: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
export const FieldStaffModel = model('FieldStaff', staffSchema);

const sessionSchema = new Schema(
  {
    staffId: { type: Schema.Types.ObjectId, ref: 'FieldStaff', required: true },
    tokenHash: { type: String, required: true, unique: true },
    method: { type: String, enum: ['password', 'otp'], required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true, versionKey: false },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const FieldSessionModel = model('FieldSession', sessionSchema);

/** One per shop: whose code it joined with, and how the code got there. */
const linkSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, unique: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'FieldStaff', required: true },
    code: { type: String, required: true },
    source: { type: String, enum: ['signup', 'onboarded', 'admin', 'owner'], required: true },
    by: { type: String, required: true },
    /** False when the code came after the shop had paid: counted for the staff, no longer trial. */
    trialGiven: { type: Boolean, required: true },
    reason: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
);
linkSchema.index({ staffId: 1, createdAt: -1 });
export const ShopStaffLinkModel = model('ShopStaffLink', linkSchema);

/** A shop filled in by field staff, waiting for its owner to sign in, check it and accept the Terms. */
const draftSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'FieldStaff', required: true },
    code: { type: String, required: true },
    shopName: { type: String, required: true },
    /** The onboarding form as the owner will see it: owner and shop, licence expiry as "YYYY-MM". */
    form: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['waiting', 'done', 'cancelled'], required: true, default: 'waiting' },
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);
draftSchema.index({ email: 1, status: 1, createdAt: -1 });
draftSchema.index({ staffId: 1, createdAt: -1 });
export const ShopDraftModel = model('ShopDraft', draftSchema);
