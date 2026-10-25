import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// D94: a shop's own address, <slug>.medbox24.in. requested → active (admin approves) or rejected; stopped by the admin;
// released when another shop takes a name that lapsed 60 days ago.
export const ADDRESS_STATUSES = ['requested', 'active', 'rejected', 'stopped', 'released'] as const;
export type AddressStatus = (typeof ADDRESS_STATUSES)[number];

const webAddressSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    slug: { type: String, required: true },
    status: { type: String, enum: ADDRESS_STATUSES, required: true },
    requestedAt: { type: Date, required: true },
    requestedByName: { type: String, required: true },
    decidedAt: { type: Date },
    decidedByName: { type: String },
    reason: { type: String, default: '' },
    // Free after the trial until this day (admin's gift); paid time comes with the add-on payment (v1.24.1).
    freeUntil: { type: Date },
    paidUntil: { type: Date },
    notes: { type: [new Schema({ text: { type: String, required: true }, byName: { type: String, required: true }, at: { type: Date, required: true } }, { _id: false })], default: [] },
  },
  { timestamps: true, versionKey: false },
);

// One open address per shop; a name belongs to one shop at a time (released ones keep their history).
webAddressSchema.index({ shopId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['requested', 'active', 'stopped'] } } });
webAddressSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['requested', 'active', 'stopped'] } } });
webAddressSchema.index({ status: 1, requestedAt: -1 });
webAddressSchema.plugin(tenantScoped);

export type WebAddress = InferSchemaType<typeof webAddressSchema>;
export const WebAddressModel = model('WebAddress', webAddressSchema);
