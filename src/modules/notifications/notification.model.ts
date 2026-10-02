import { Schema, model } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';
import { NOTIFICATION_TYPES } from './notification.catalog';

const DAY = 24 * 60 * 60;

// Events that happen once (a tier up, a big discount); state-based alerts are worked out live (sandbox state.js).
const eventSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    key: { type: String, required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    route: { type: String, default: '' },
    /** Who sees it: system roles, and/or a permission. Empty = everyone in the shop. */
    roles: { type: [String], default: [] },
    perm: { module: String, action: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
eventSchema.index({ shopId: 1, key: 1 }, { unique: true });
eventSchema.index({ shopId: 1, createdAt: -1 });
eventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * DAY });
eventSchema.plugin(tenantScoped);
export const NotificationModel = model('Notification', eventSchema);

// Per person and shop: read and "Later" (snoozed until 9 AM IST next day, never for critical).
const stateSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true },
    readAt: { type: Date },
    snoozedUntil: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
stateSchema.index({ shopId: 1, userId: 1, key: 1 }, { unique: true });
stateSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * DAY });
stateSchema.plugin(tenantScoped);
export const NotificationStateModel = model('NotificationState', stateSchema);

// PLAN §17 per-user preferences: only what differs from the type's default channels is stored.
const prefSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    off: { type: [new Schema({ kind: { type: String, enum: NOTIFICATION_TYPES, required: true }, channel: { type: String, enum: ['inapp', 'email'], required: true } }, { _id: false })], default: [] },
  },
  { timestamps: true, versionKey: false },
);
prefSchema.index({ shopId: 1, userId: 1 }, { unique: true });
prefSchema.plugin(tenantScoped);
export const NotificationPrefModel = model('NotificationPref', prefSchema);
