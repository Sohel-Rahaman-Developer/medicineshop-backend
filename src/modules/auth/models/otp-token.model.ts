/**
 * OtpToken — the one-time code for email login.
 *
 * The OTP is never stored in plain text (bcrypt hash). Expired documents are
 * removed by MongoDB itself via a TTL index, so no cleanup job is needed.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const otpTokenSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    otpHash: { type: String, required: true },
    purpose: { type: String, enum: ['login'], default: 'login' },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },

    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },

    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// Finding the latest unconsumed OTP for an address.
otpTokenSchema.index({ email: 1, purpose: 1, consumedAt: 1, createdAt: -1 });

// TTL: Mongo deletes the document once expiresAt passes.
// NOTE: the TTL monitor only runs about once a minute, so deletion can lag.
// Never rely on this index for correctness — expiry is checked explicitly
// during verification.
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpTokenModel = model('OtpToken', otpTokenSchema);

export type OtpToken = InferSchemaType<typeof otpTokenSchema>;
export type OtpTokenDoc = InstanceType<typeof OtpTokenModel>;
