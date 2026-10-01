// User — one person's identity, global and not owned by any shop (PLAN §21.2).
import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true,
    },
    /** Set on the first successful OTP login. A user created by an invite stays null until then. */
    emailVerifiedAt: { type: Date },
    name: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true },
    avatar: { type: String },
    /** Platform-level only (fraud, legal). A shop suspending staff is a Membership state. */
    status: { type: String, enum: ['active', 'disabled'], default: 'active', required: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

export const UserModel = model('User', userSchema);

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = InstanceType<typeof UserModel>;
