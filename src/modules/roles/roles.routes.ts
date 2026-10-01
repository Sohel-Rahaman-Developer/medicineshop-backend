import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { actorOf } from '../user/actor';
import * as svc from './roles.service';
import { createRoleSchema, roleIdSchema, updateRoleSchema, type CreateRoleInput, type UpdateRoleInput } from './roles.validation';

export const rolesRouter = Router();
rolesRouter.use(requireAuth, tenant);

const idOf = (req: Request) => (req.params as { id: string }).id;

rolesRouter.get(
  '/',
  requirePermission('roles', 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.list(tenantOf(req)));
  }),
);

rolesRouter.get(
  '/:id',
  requirePermission('roles', 'view'),
  validate({ params: roleIdSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.get(tenantOf(req), idOf(req)));
  }),
);

rolesRouter.post(
  '/',
  requirePermission('roles', 'create'),
  validate({ body: createRoleSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const out = await svc.create(tenantOf(req), await actorOf(req), req.body as CreateRoleInput, req.ip);
    created(res, out, 'Role created');
  }),
);

rolesRouter.put(
  '/:id',
  requirePermission('roles', 'edit'),
  validate({ params: roleIdSchema, body: updateRoleSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.update(tenantOf(req), await actorOf(req), idOf(req), req.body as UpdateRoleInput, req.ip);
    sent(res, null, 'Role saved');
  }),
);

rolesRouter.delete(
  '/:id',
  requirePermission('roles', 'delete'),
  validate({ params: roleIdSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.remove(tenantOf(req), await actorOf(req), idOf(req), req.ip);
    sent(res, null, 'Role deleted');
  }),
);
