import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'grace', 'expired', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// B1 creates the trial; B8 adds payments, renewals and the status job.
const subscriptionSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, unique: true },
    planCode: { type: String, enum: ['trial', 'monthly', 'yearly'], required: true },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    graceEndDate: { type: Date },
    maxUsers: { type: Number, required: true },
    trialExtensions: { type: Number, default: 0 },
    cancelledAt: { type: Date },
    cancelReason: { type: String },
  },
  { timestamps: true, versionKey: false },
);

subscriptionSchema.plugin(tenantScoped);

export const SubscriptionModel = model('Subscription', subscriptionSchema);
export type Subscription = InferSchemaType<typeof subscriptionSchema>;

const DAY = 24 * 60 * 60 * 1000;
/** Platform settings (B9) set it; 7 until they load. */
let graceDays = 7;
export const setGraceDays = (n: number) => {
  graceDays = n;
};

/** PLAN §8: trial / active until the end date, then 7 days of grace, then read-only. Cancelled stays cancelled. */
export function statusAt(sub: { status: SubscriptionStatus; planCode: string; endDate: Date }, now: Date): SubscriptionStatus {
  if (sub.status === 'cancelled') return 'cancelled';
  if (now < sub.endDate) return sub.planCode === 'trial' ? 'trial' : 'active';
  return now.getTime() < sub.endDate.getTime() + graceDays * DAY ? 'grace' : 'expired';
}
export const graceEndOf = (endDate: Date) => new Date(endDate.getTime() + graceDays * DAY);

/** Read-only states (PLAN §5): browsing and download work, nothing can be written. */
export function isReadOnly(status: SubscriptionStatus): boolean {
  return status === 'expired' || status === 'cancelled';
}
