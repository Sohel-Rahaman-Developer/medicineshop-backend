import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended', 'declined', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

const membershipSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    designation: { type: String, trim: true, default: '' },
    status: { type: String, enum: MEMBERSHIP_STATUSES, required: true },
    grants: { type: Schema.Types.Mixed, default: () => ({}) },
    denies: { type: Schema.Types.Mixed, default: () => ({}) },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    invitedAt: { type: Date },
    joinedAt: { type: Date },
    declinedAt: { type: Date },
    suspendedAt: { type: Date },
    removedAt: { type: Date },
    removedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    lastActiveAt: { type: Date },
  },
  { timestamps: true, versionKey: 'version', optimisticConcurrency: true, minimize: false },
);

membershipSchema.index({ shopId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1, status: 1 });
membershipSchema.index({ shopId: 1, status: 1 });
membershipSchema.index({ shopId: 1, roleId: 1 });
membershipSchema.plugin(tenantScoped);

export const MembershipModel = model('Membership', membershipSchema);
export type Membership = InferSchemaType<typeof membershipSchema>;
export type MembershipDoc = InstanceType<typeof MembershipModel>;
