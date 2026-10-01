// Session — one refresh token is one session document.
import { Schema, model, type InferSchemaType } from 'mongoose';

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** SHA-256 of the refresh token. The plain token never touches the database. */
    tokenHash: { type: String, required: true, unique: true },

    familyId: { type: String, required: true, index: true },

    rememberMe: { type: Boolean, default: true },

    deviceInfo: { type: String, default: '' },
    ip: { type: String },
    userAgent: { type: String },

    lastUsedAt: { type: Date, default: Date.now },

    expiresAt: { type: Date, required: true },

    absoluteExpiresAt: { type: Date, required: true },

    /** Set on rotation. Non-null means this token has already been spent. */
    usedAt: { type: Date },

    revokedAt: { type: Date },
    revokedReason: {
      type: String,
      enum: ['logout', 'logout_all', 'rotated', 'reuse_detected', 'user_revoked', 'membership_removed', 'disabled'],
    },
  },
  { timestamps: true, versionKey: false },
);

sessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: -1 });

sessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = model('Session', sessionSchema);

export type Session = InferSchemaType<typeof sessionSchema>;
export type SessionDoc = InstanceType<typeof SessionModel>;
