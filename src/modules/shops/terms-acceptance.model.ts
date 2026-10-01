import { Schema, model } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// Append-only record of who agreed to which Terms version (PLAN §36.4).
const termsAcceptanceSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    version: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    ip: { type: String },
    userAgent: { type: String },
    at: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false },
);

termsAcceptanceSchema.index({ shopId: 1, at: -1 });
termsAcceptanceSchema.plugin(tenantScoped);

export const TermsAcceptanceModel = model('TermsAcceptance', termsAcceptanceSchema);
