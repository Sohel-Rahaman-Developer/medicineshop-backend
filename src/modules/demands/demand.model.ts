import { Schema, model } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// Short book / buy list (PLAN §35.2): a product, or only a name that joins a product later.
const demandSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true },
    /** Free text and may be empty: "amount not decided". */
    qty: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['open', 'ordered', 'cleared'], required: true, default: 'open' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
    at: { type: Date, required: true },
    clearedBy: { type: String },
    clearedAt: { type: Date },
  },
  { versionKey: false },
);

demandSchema.index({ shopId: 1, status: 1, at: -1 });
demandSchema.index({ shopId: 1, productId: 1, status: 1 });
demandSchema.plugin(tenantScoped);

export const DemandModel = model('Demand', demandSchema);
