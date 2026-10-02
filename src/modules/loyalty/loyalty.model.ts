import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// PLAN §21.8: Customer.loyaltyPoints is the sum of this ledger. REVERSAL is signed: − takes earned points back, + gives redeemed ones back.
export const LOYALTY_TYPES = ['EARN', 'REDEEM', 'REVERSAL', 'MANUAL_ADD', 'MANUAL_DEDUCT', 'EXPIRE', 'SIGNUP', 'BIRTHDAY'] as const;
export type LoyaltyType = (typeof LOYALTY_TYPES)[number];
export const LOYALTY_REFS = ['SALE', 'RETURN', 'MANUAL', 'SIGNUP', 'BIRTHDAY', 'SYSTEM'] as const;

const loyaltySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    type: { type: String, enum: LOYALTY_TYPES, required: true },
    points: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    // A credit is a FIFO lot: redeem and expiry eat the oldest `remaining` first.
    remaining: { type: Number },
    expiresAt: { type: Date, default: null },
    refType: { type: String, enum: LOYALTY_REFS, required: true },
    refId: { type: Schema.Types.ObjectId },
    refNumber: { type: String, default: '' },
    reason: { type: String, default: '' },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

loyaltySchema.index({ shopId: 1, customerId: 1, createdAt: -1, _id: -1 });
loyaltySchema.index({ shopId: 1, customerId: 1, createdAt: 1 }, { partialFilterExpression: { remaining: { $gt: 0 } } });
loyaltySchema.index({ shopId: 1, expiresAt: 1 }, { partialFilterExpression: { remaining: { $gt: 0 } } });
loyaltySchema.index({ shopId: 1, createdAt: -1 });
loyaltySchema.plugin(tenantScoped);

export const LoyaltyModel = model('LoyaltyTransaction', loyaltySchema);
export type LoyaltyTx = InferSchemaType<typeof loyaltySchema>;
