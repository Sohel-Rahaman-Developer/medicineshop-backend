import { Schema, model } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const ATTACHMENT_OWNERS = ['Purchase', 'StockAdjustment'] as const;
export type AttachmentOwner = (typeof ATTACHMENT_OWNERS)[number];

// A photo of a paper (supplier invoice, damaged stock), re-encoded on the server (D51). One per owner.
const attachmentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    ownerType: { type: String, enum: ATTACHMENT_OWNERS, required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    mime: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    bytes: { type: Number, required: true },
    data: { type: Buffer, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

attachmentSchema.index({ shopId: 1, ownerType: 1, ownerId: 1 }, { unique: true });
attachmentSchema.plugin(tenantScoped);

export const AttachmentModel = model('Attachment', attachmentSchema);
