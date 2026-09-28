/**
 * User — a global record, not owned by any one shop.
 *
 * The same person can work at several shops (an owner with two branches, or an
 * employee with two jobs). The link to a shop lives in `ShopMembership`, not
 * here — which is why this model deliberately has no `shopId`.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      // This is the login identity, so always store it lowercased and trimmed.
      // Otherwise "Sohel@x.com" and "sohel@x.com" become two different users.
      lowercase: true,
      trim: true,
      unique: true,
      index: true,
    },
    name: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true },
    avatar: { type: String },
    status: {
      type: String,
      enum: ['active', 'invited', 'blocked'],
      default: 'active',
      index: true,
    },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

export const UserModel = model('User', userSchema);

export type User = InferSchemaType<typeof userSchema>;
// NOTE: `HydratedDocument<User>` does not work here because the schema sets
// `versionKey: false` (there is no `__v`) while that helper expects one.
// Taking the instance type straight off the model is the correct approach.
export type UserDoc = InstanceType<typeof UserModel>;
