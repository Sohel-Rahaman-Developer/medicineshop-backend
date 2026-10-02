import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const MOVEMENT_TYPES = [
  'PURCHASE', 'SALE', 'SALE_RETURN', 'SALE_CANCEL', 'PURCHASE_RETURN', 'PURCHASE_CANCEL', 'ADJUST_IN', 'ADJUST_OUT',
  'DAMAGE', 'EXPIRY_WRITE_OFF', 'SELF_USE', 'RACK_MOVE', 'OPENING',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

// The stock ledger (PLAN §12): append-only, no update or delete API. Batch.quantity = sum of its movements.
const movementSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    batchId: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    quantity: { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    costPerBaseUnit: { type: Number, required: true },
    refType: { type: String, required: true },
    refId: { type: Schema.Types.ObjectId },
    refNumber: { type: String },
    reason: { type: String },
    rackFrom: { type: String },
    rackTo: { type: String },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { versionKey: false },
);

movementSchema.index({ shopId: 1, at: -1, _id: -1 });
movementSchema.index({ shopId: 1, productId: 1, at: -1, _id: -1 });
movementSchema.index({ shopId: 1, batchId: 1, at: -1, _id: -1 });
movementSchema.index({ shopId: 1, fy: 1 });
movementSchema.plugin(tenantScoped);

export const MovementModel = model('StockMovement', movementSchema);
export type Movement = InferSchemaType<typeof movementSchema>;
