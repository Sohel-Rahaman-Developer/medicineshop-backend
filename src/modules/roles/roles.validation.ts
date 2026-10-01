import { z } from 'zod';
import { MODULES, permissionsSchema } from '../rbac/permissions';

const fields = {
  name: z.string().trim().min(2, 'Give the role a name').max(40),
  description: z.string().trim().max(160).default(''),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'Pick a colour').default('#8b5cf6'),
  permissions: permissionsSchema.refine((p) => Object.keys(p).length > 0, 'Tick at least one permission'),
  scopes: z.partialRecord(z.enum(MODULES), z.enum(['own', 'shop'])).default({}),
};

export const createRoleSchema = z.object(fields).strict();
export const updateRoleSchema = z.object({ ...fields, version: z.number().int().nonnegative() }).strict();
export const roleIdSchema = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id') }).strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
