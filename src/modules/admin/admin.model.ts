import { Schema, model, type InferSchemaType } from 'mongoose';

// The platform team lives apart from shop users (PLAN §21.1): own collection, own session, own audit — a shop login can never act here.

export const ADMIN_ROLES = ['super', 'support', 'accounts', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const adminUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ADMIN_ROLES, required: true },
    /** AES-256-GCM sealed base32 secret; set on first login, enabled once a code checks out. */
    totpSecretEnc: { type: String },
    totpEnabledAt: { type: Date },
    /** The last TOTP step used — the same code can't sign in twice. */
    totpLastStep: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'disabled'], required: true, default: 'active' },
    invitedBy: { type: String },
    lastLoginAt: { type: Date },
    /** Quick unlock after the idle lock (bcrypt); sign-in still needs the email code + authenticator. */
    pinHash: { type: String },
    pinFails: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
export const AdminUserModel = model('AdminUser', adminUserSchema);
export type AdminUser = InferSchemaType<typeof adminUserSchema>;

/** `pre` = OTP passed, TOTP pending (10 min); `full` = signed in (8 hours absolute). Only the token's hash is stored. */
const adminSessionSchema = new Schema(
  {
    adminUserId: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    tokenHash: { type: String, required: true, unique: true },
    stage: { type: String, enum: ['pre', 'full'], required: true },
    /** Pending TOTP secret during first-time setup (sealed). */
    setupSecretEnc: { type: String },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date },
    /** Set by "Lock now" or by the idle check; every route but unlock answers 423 until it clears. */
    lockedAt: { type: Date },
    revokedAt: { type: Date },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true, versionKey: false },
);
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
adminSessionSchema.index({ adminUserId: 1, revokedAt: 1 });
export const AdminSessionModel = model('AdminSession', adminSessionSchema);

/** Append-only: every admin action with its reason (PLAN §21.11). */
const adminAuditSchema = new Schema(
  {
    adminUserId: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    adminName: { type: String, required: true },
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop' },
    shopName: { type: String },
    action: { type: String, required: true },
    reason: { type: String, required: true },
    text: { type: String, required: true },
    changes: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
adminAuditSchema.index({ createdAt: -1, _id: -1 });
adminAuditSchema.index({ shopId: 1, createdAt: -1 });
export const AdminAuditModel = model('AdminAuditLog', adminAuditSchema);

const platformSchema = new Schema(
  {
    _id: { type: String, default: 'platform' },
    trialDays: { type: Number, required: true, default: 14 },
    trialMaxUsers: { type: Number, required: true, default: 3 },
    graceDays: { type: Number, required: true, default: 7 },
    supportEmail: { type: String, default: '' },
    supportPhone: { type: String, default: '' },
    maintenance: { on: { type: Boolean, default: false }, message: { type: String, default: '' } },
    updatedBy: { type: String },
  },
  { timestamps: true, versionKey: false },
);
export const PlatformSettingsModel = model('PlatformSettings', platformSchema);
