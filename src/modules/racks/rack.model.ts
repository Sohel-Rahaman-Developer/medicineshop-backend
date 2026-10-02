import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const STORAGE_TYPES = ['NORMAL', 'COLD', 'CONTROLLED'] as const;
export type StorageType = (typeof STORAGE_TYPES)[number];

// A-2-1 = Almirah A → Rack 2 → Tray 1, F-1 = fridge (PLAN §11). Batches keep the code itself.
const rackSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, trim: true, default: '' },
    storageType: { type: String, enum: STORAGE_TYPES, required: true, default: 'NORMAL' },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, versionKey: false },
);
rackSchema.index({ shopId: 1, code: 1 }, { unique: true });
rackSchema.plugin(tenantScoped);

export const RackModel = model('Rack', rackSchema);
export type Rack = InferSchemaType<typeof rackSchema>;
