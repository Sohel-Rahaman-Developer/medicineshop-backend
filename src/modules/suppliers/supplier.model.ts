import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// A distributor (PLAN §21.4). payableBalance = invoices − payments − returns, rewritten in the same transaction.
const supplierSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true },
    code: { type: String, required: true },
    contactPerson: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, default: '' },
    address: { type: String, trim: true, default: '' },
    gstin: { type: String, trim: true, uppercase: true, default: '' },
    drugLicense: { type: String, trim: true, default: '' },
    creditDays: { type: Number, required: true, default: 30 },
    /** Paise we owe; negative when they hold our advance. */
    payableBalance: { type: Number, required: true, default: 0 },
    /** Credit not yet used against an invoice; the next invoice takes it first. */
    advance: { type: Number, required: true, default: 0 },
    totalPurchases: { type: Number, required: true, default: 0 },
    lastPurchaseAt: { type: Date, default: null },
    isActive: { type: Boolean, required: true, default: true },
    notes: { type: String, trim: true, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: 'version', minimize: false },
);

supplierSchema.index({ shopId: 1, nameLower: 1 }, { unique: true });
supplierSchema.index({ shopId: 1, payableBalance: -1, _id: -1 });
supplierSchema.plugin(tenantScoped);

export const SupplierModel = model('Supplier', supplierSchema);
export type Supplier = InferSchemaType<typeof supplierSchema>;
