import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';
import { SYSTEM_ROLE_KEYS, type Permissions, type Scopes } from '../rbac/permissions';

const roleSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    systemKey: { type: String, enum: SYSTEM_ROLE_KEYS },
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true },
    description: { type: String, trim: true, default: '' },
    color: { type: String, default: '#8b5cf6' },
    permissions: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    scopes: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    isSystem: { type: Boolean, required: true, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: 'version', optimisticConcurrency: true, minimize: false },
);

roleSchema.index({ shopId: 1, nameLower: 1 }, { unique: true });
roleSchema.index({ shopId: 1, systemKey: 1 }, { unique: true, partialFilterExpression: { systemKey: { $type: 'string' } } });
roleSchema.plugin(tenantScoped);

export const RoleModel = model('Role', roleSchema);
export type Role = Omit<InferSchemaType<typeof roleSchema>, 'permissions' | 'scopes'> & { permissions: Permissions; scopes: Scopes };
export type RoleDoc = InstanceType<typeof RoleModel>;
