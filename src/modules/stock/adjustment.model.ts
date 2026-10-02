import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const ADJUSTMENT_TYPES = ['PHYSICAL_COUNT', 'DAMAGE', 'EXPIRY_WRITE_OFF', 'SELF_USE', 'TRANSFER'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

const lineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
    batchNumber: { type: String, required: true },
    systemQty: { type: Number, required: true },
    actualQty: { type: Number, required: true },
    difference: { type: Number, required: true },
    value: { type: Number, required: true },
    rackFrom: { type: String },
    rackTo: { type: String },
  },
  { _id: false },
);

const adjustmentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    adjustmentNumber: { type: String, required: true },
    type: { type: String, enum: ADJUSTMENT_TYPES, required: true },
    lines: { type: [lineSchema], required: true },
    totalValue: { type: Number, required: true },
    reason: { type: String, required: true },
    notes: { type: String, default: '' },
    approvedBy: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

adjustmentSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true });
adjustmentSchema.index({ shopId: 1, adjustmentNumber: 1 }, { unique: true });
adjustmentSchema.index({ shopId: 1, createdAt: -1, _id: -1 });
adjustmentSchema.index({ shopId: 1, fy: 1 });
adjustmentSchema.plugin(tenantScoped);

export const AdjustmentModel = model('StockAdjustment', adjustmentSchema);
export type Adjustment = InferSchemaType<typeof adjustmentSchema>;
