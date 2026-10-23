import { Schema, model } from 'mongoose';

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** A category a shop asked for; MedBox24 approves it once and it reaches every shop. Platform-wide, so not tenant-scoped. */
const requestSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    key: { type: String, required: true, unique: true },
    status: { type: String, enum: REQUEST_STATUSES, required: true, default: 'pending' },
    shops: {
      type: [new Schema({ shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true }, shopName: { type: String, required: true }, userName: { type: String, required: true }, at: { type: Date, required: true } }, { _id: false })],
      default: [],
    },
    // One single-use link per super admin, stored as a SHA-256 hash.
    links: { type: [new Schema({ adminId: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true }, hash: { type: String, required: true } }, { _id: false })], default: [] },
    linksExpire: { type: Date, required: true },
    // Links already used, so the page can still say who decided.
    usedHashes: { type: [String], default: [] },
    decidedBy: { type: String },
    decidedVia: { type: String, enum: ['email', 'console'] },
    decidedAt: { type: Date },
    reason: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
);
requestSchema.index({ 'links.hash': 1 });
requestSchema.index({ usedHashes: 1 });
requestSchema.index({ 'shops.shopId': 1 });

export const CategoryRequestModel = model('CategoryRequest', requestSchema);
