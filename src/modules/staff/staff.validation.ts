import { z } from 'zod';
import { permissionsSchema } from '../rbac/permissions';
import { phone } from '../shops/shops.validation';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const memberIdSchema = z.object({ id: objectId }).strict();

export const inviteSchema = z
  .object({
    email: z.email('Enter a valid email address').trim().toLowerCase(),
    name: z.string().trim().min(1, 'Name is required').max(80),
    phone: phone('Phone').optional(),
    roleId: objectId,
    designation: z.string().trim().max(40).optional(),
    grants: permissionsSchema.optional(),
    denies: permissionsSchema.optional(),
  })
  .strict();

export const updateMemberSchema = z
  .object({
    roleId: objectId,
    designation: z.string().trim().max(40).default(''),
    grants: permissionsSchema.default({}),
    denies: permissionsSchema.default({}),
    version: z.number().int().nonnegative(),
  })
  .strict();

export const statusActionSchema = z.object({ id: objectId, action: z.enum(['suspend', 'reactivate', 'remove', 'reinvite', 'sign-out']) }).strict();

export type InviteInput = z.infer<typeof inviteSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
