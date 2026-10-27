import { Schema, model } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// D104: a counter that can bill offline. Its bills carry its own series (OFL1-2026-27-0001), numbered on the device
// at the moment of sale; the server keeps the last number it has seen per financial year.
const posDeviceSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    /** A random id the browser keeps; the same browser always gets the same code back. */
    key: { type: String, required: true },
    code: { type: String, required: true },
    name: { type: String, default: '' },
    seqs: { type: [new Schema({ fy: { type: String, required: true }, seq: { type: Number, required: true } }, { _id: false })], default: [] },
    lastSyncAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
posDeviceSchema.index({ shopId: 1, key: 1 }, { unique: true });
posDeviceSchema.index({ shopId: 1, code: 1 }, { unique: true });
posDeviceSchema.plugin(tenantScoped);

export const PosDeviceModel = model('PosDevice', posDeviceSchema);
