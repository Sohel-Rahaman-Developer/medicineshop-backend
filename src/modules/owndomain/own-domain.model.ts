import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';
import { ADDRESS_STATUSES } from '../webaddress/web-address.model';

// v1.26 (D94): the shop's own domain, krishnamedical.in — one it has ("own") or one MedBox24 buys for it ("buy").
// requested → active (DNS points here, the server is set up, the team switches it on) or rejected; stopped; released.
export const DOMAIN_KINDS = ['own', 'buy'] as const;
export type DomainKind = (typeof DOMAIN_KINDS)[number];

const ownDomainSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    /** The bare name, small letters, no www. */
    domain: { type: String, required: true },
    kind: { type: String, enum: DOMAIN_KINDS, required: true },
    status: { type: String, enum: ADDRESS_STATUSES, required: true },
    requestedAt: { type: Date, required: true },
    requestedByName: { type: String, required: true },
    decidedAt: { type: Date },
    decidedByName: { type: String },
    reason: { type: String, default: '' },
    // The add-on, as for the web address: free in the trial, then given free or paid.
    freeUntil: { type: Date },
    paidUntil: { type: Date },
    /** "buy": the yearly price of the name, set by the team after the call (paise, GST inside); always paid. */
    buyPrice: { type: Number },
    /** "buy": the name is paid for till this day. */
    domainPaidUntil: { type: Date },
    dnsOk: { type: Boolean, default: false },
    dnsCheckedAt: { type: Date },
    notes: { type: [new Schema({ text: { type: String, required: true }, byName: { type: String, required: true }, at: { type: Date, required: true } }, { _id: false })], default: [] },
  },
  { timestamps: true, versionKey: false },
);

ownDomainSchema.index({ shopId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['requested', 'active', 'stopped'] } } });
ownDomainSchema.index({ domain: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['requested', 'active', 'stopped'] } } });
ownDomainSchema.index({ status: 1, requestedAt: -1 });
ownDomainSchema.plugin(tenantScoped);

export type OwnDomain = InferSchemaType<typeof ownDomainSchema>;
export const OwnDomainModel = model('OwnDomain', ownDomainSchema);
