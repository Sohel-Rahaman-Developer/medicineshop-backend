import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { shopAuth, tenantOf, type TenantContext } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched } from '../../core/response';
import { istDay, LIMIT, objectId } from '../../core/zod';
import { AUDIT_ACTIONS, AuditLogModel } from './audit.model';

const DAY = 24 * 60 * 60 * 1000;

const listSchema = z
  .object({
    userId: objectId.optional(),
    module: z.string().trim().max(40).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    from: istDay.optional(),
    to: istDay.optional(),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();
type ListQuery = z.infer<typeof listSchema>;

/** S76: Owner and Manager only (sandbox `ownerManager`) — the log shows everyone's actions, so it isn't a grantable permission. */
const ownerManager = (t: TenantContext) => t.isOwner || t.roleKey === 'owner' || t.roleKey === 'manager';

export const auditRouter = Router();
auditRouter.use(shopAuth, (req, _res, next) => {
  next(ownerManager(tenantOf(req)) ? undefined : AppError.forbidden('Only the Owner or Manager can see the audit log'));
});

auditRouter.get(
  '/',
  validate({ query: listSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const t = tenantOf(req);
    const q = req.query as unknown as ListQuery;
    const filter: Record<string, unknown> = { shopId: t.shopId };
    if (q.userId) filter.userId = new Types.ObjectId(q.userId);
    if (q.module) filter.module = q.module;
    if (q.action) filter.action = q.action;
    if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lt: new Date(q.to.getTime() + DAY) } : {}) };
    const sort = { field: 'createdAt', dir: -1 as const };
    const after = afterCursor(q.cursor, sort);
    const rows = await AuditLogModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(q.limit + 1)
      .select('userId userName action module entityId entityName text changes createdAt')
      .lean();
    const { items, meta } = page(rows, q.limit, (r) => (r as { createdAt?: Date }).createdAt ?? new Date(0));
    fetched(
      res,
      items.map((a) => ({ id: String(a._id), at: (a as { createdAt?: Date }).createdAt ?? null, userId: String(a.userId), userName: a.userName, action: a.action, module: a.module, entityId: a.entityId ?? null, entityName: a.entityName ?? null, text: a.text, changes: (a.changes as unknown) ?? null })),
      meta,
    );
  }),
);

/** The filter lists: who appears in the log, and which modules. */
auditRouter.get(
  '/filters',
  asyncHandler(async (req: Request, res: Response) => {
    const t = tenantOf(req);
    const [users, modules] = await Promise.all([
      AuditLogModel.aggregate<{ _id: Types.ObjectId; name: string }>([{ $match: { shopId: t.shopId } }, { $group: { _id: '$userId', name: { $last: '$userName' } } }, { $sort: { name: 1 } }]),
      AuditLogModel.distinct('module', { shopId: t.shopId }),
    ]);
    fetched(res, { users: users.map((u) => ({ id: String(u._id), name: u.name })), modules: modules.sort(), actions: AUDIT_ACTIONS });
  }),
);
