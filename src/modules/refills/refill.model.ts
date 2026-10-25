import { Schema, model } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// D103: what the shop did about one customer's refill of one medicine — reminded (when, by whom) or "not a regular".
const refillMarkSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    remindedAt: { type: Date, default: null },
    remindedBy: { type: String, default: '' },
    how: { type: String, enum: ['', 'whatsapp', 'call'], default: '' },
    stopped: { type: Boolean, default: false },
    stoppedBy: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
);
refillMarkSchema.index({ shopId: 1, customerId: 1, productId: 1 }, { unique: true });
refillMarkSchema.plugin(tenantScoped);

export const RefillMarkModel = model('RefillMark', refillMarkSchema);
