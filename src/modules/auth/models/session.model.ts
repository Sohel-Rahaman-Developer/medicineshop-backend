/**
 * Session — one refresh token is one session document.
 *
 * Because tokens rotate, every refresh creates a NEW document and marks the
 * old one with `usedAt`. We do not delete the old one: its record is exactly
 * what lets us detect reuse.
 *
 * familyId groups everything that grew out of a single login:
 *
 *   login → S1(family F) → refresh → S2(F) → refresh → S3(F)
 *
 * If someone presents S1 again after it was already spent, the token has
 * leaked — so the entire family F is revoked.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** SHA-256 of the refresh token. The plain token never touches the database. */
    tokenHash: { type: String, required: true, unique: true },

    familyId: { type: String, required: true, index: true },

    /** Was "remember me" on? It gives the session a longer TTL. */
    rememberMe: { type: Boolean, default: true },

    deviceInfo: { type: String, default: '' },
    ip: { type: String },
    userAgent: { type: String },

    lastUsedAt: { type: Date, default: Date.now },

    /** Sliding expiry — pushed forward on every refresh. */
    expiresAt: { type: Date, required: true },

    /**
     * Absolute cap. However active the user is, they must sign in again after
     * this date. It stops sliding expiry from becoming effectively infinite.
     */
    absoluteExpiresAt: { type: Date, required: true },

    /** Set on rotation. Non-null means this token has already been spent. */
    usedAt: { type: Date },

    revokedAt: { type: Date },
    revokedReason: {
      type: String,
      enum: ['logout', 'logout_all', 'rotated', 'reuse_detected', 'admin_revoked', 'membership_removed'],
    },
  },
  { timestamps: true, versionKey: false },
);

// "Show this user's active sessions" (Settings → Security)
sessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: -1 });

// Let dead sessions clean themselves up. Past absoluteExpiresAt a session is
// useless for both login and reuse detection.
sessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = model('Session', sessionSchema);

export type Session = InferSchemaType<typeof sessionSchema>;
export type SessionDoc = InstanceType<typeof SessionModel>;
