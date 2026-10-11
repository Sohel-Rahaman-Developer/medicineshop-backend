import { Schema, model } from 'mongoose';

// The platform's logo (one document): no mark = the built-in MedBox24 mark. The version grows on every change, reset included.
const brandSchema = new Schema(
  {
    _id: { type: String, default: 'brand' },
    /** 1024 × 1024 PNG, logo centred on transparent. */
    mark: { type: Buffer },
    hasAlpha: { type: Boolean, default: true },
    version: { type: Number, required: true },
    updatedBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

export const BrandModel = model('Brand', brandSchema);
