import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import type { Action } from '../rbac/permissions';
import { actorOf } from '../user/actor';
import * as svc from './staff.service';
import { inviteSchema, memberIdSchema, updateMemberSchema, type InviteInput, type UpdateMemberInput } from './staff.validation';

export const staffRouter = Router();
staffRouter.use(requireAuth, tenant);

const idOf = (req: Request) => (req.params as { id: string }).id;

staffRouter.get(
  '/',
  requirePermission('staff', 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.list(tenantOf(req)));
  }),
);

staffRouter.get(
  '/roles',
  requirePermission('staff', 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.assignableRoles(tenantOf(req)));
  }),
);

staffRouter.get(
  '/:id',
  requirePermission('staff', 'view'),
  validate({ params: memberIdSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.detail(tenantOf(req), idOf(req)));
  }),
);

staffRouter.post(
  '/',
  requirePermission('staff', 'create'),
  validate({ body: inviteSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as InviteInput;
    const out = await svc.invite(tenantOf(req), await actorOf(req), body, req.ip);
    created(res, out, `Invitation sent to ${body.email}`);
  }),
);

staffRouter.put(
  '/:id',
  requirePermission('staff', 'edit'),
  validate({ params: memberIdSchema, body: updateMemberSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await svc.update(tenantOf(req), await actorOf(req), idOf(req), req.body as UpdateMemberInput, req.ip);
    sent(res, null, 'Access updated');
  }),
);

const ACTIONS: Record<'suspend' | 'reactivate' | 'remove' | 'reinvite' | 'sign-out', Action> = {
  suspend: 'edit',
  reactivate: 'edit',
  'sign-out': 'edit',
  remove: 'delete',
  reinvite: 'create',
};

for (const [action, permission] of Object.entries(ACTIONS) as [keyof typeof ACTIONS, Action][]) {
  staffRouter.post(
    `/:id/${action}`,
    requirePermission('staff', permission),
    validate({ params: memberIdSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      sent(res, null, await svc.act(tenantOf(req), await actorOf(req), idOf(req), action, req.ip));
    }),
  );
}
