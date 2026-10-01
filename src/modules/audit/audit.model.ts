import { Schema, model, type ClientSession, type Types } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';
import { fyOf } from '../../utils/fy';

export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'cancel', 'login', 'permission_change', 'share_initiated'] as const;

// Append-only: no update or delete API exists for this collection.
const auditSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    module: { type: String, required: true },
    entityId: { type: String },
    entityName: { type: String },
    text: { type: String, required: true },
    changes: { type: Schema.Types.Mixed },
    ip: { type: String },
    device: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

auditSchema.index({ shopId: 1, createdAt: -1 });
auditSchema.index({ shopId: 1, userId: 1, createdAt: -1 });
auditSchema.index({ shopId: 1, module: 1, createdAt: -1 });
auditSchema.index({ shopId: 1, fy: 1 });
auditSchema.plugin(tenantScoped);

export const AuditLogModel = model('AuditLog', auditSchema);

export interface AuditEntry {
  shopId: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  userName: string;
  action: (typeof AUDIT_ACTIONS)[number];
  module: string;
  entityId?: string;
  entityName?: string;
  text: string;
  changes?: { before: unknown; after: unknown };
  ip?: string;
  device?: string;
}

export async function audit(entry: AuditEntry, session?: ClientSession): Promise<void> {
  await AuditLogModel.create([{ ...entry, fy: fyOf(new Date()) }], { session });
}
