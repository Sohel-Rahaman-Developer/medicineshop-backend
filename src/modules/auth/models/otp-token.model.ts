// OtpToken — the one-time code for email login.
import { Schema, model, type InferSchemaType } from 'mongoose';

const otpTokenSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    otpHash: { type: String, required: true },
    /** Shop app and admin app codes never mix (PLAN §21.2). */
    audience: { type: String, enum: ['shop', 'admin'], default: 'shop', required: true },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },

    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },

    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

otpTokenSchema.index({ audience: 1, email: 1, consumedAt: 1, createdAt: -1 });

// TTL: Mongo deletes the document once expiresAt passes.
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpTokenModel = model('OtpToken', otpTokenSchema);

export type OtpToken = InferSchemaType<typeof otpTokenSchema>;
export type OtpTokenDoc = InstanceType<typeof OtpTokenModel>;
