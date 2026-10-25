import { Schema, model } from 'mongoose';

// v1.26: signed in on medbox24.in, opening the shop on its own domain — a one-time code, good for 60 seconds, for that
// one domain. Only its hash is kept; Mongo drops it when it expires.
const handoffSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The own domain's origin it may be used on. */
    origin: { type: String, required: true },
    rememberMe: { type: Boolean, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
handoffSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const HandoffModel = model('Handoff', handoffSchema);
