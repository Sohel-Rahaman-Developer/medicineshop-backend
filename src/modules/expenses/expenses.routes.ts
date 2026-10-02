import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as svc from './expenses.service';
import { deleteExpenseSchema, expenseListSchema, expenseSchema, updateExpenseSchema, type ExpenseInput, type ExpenseListQuery, type UpdateExpenseInput } from './expenses.validation';

const idOf = (req: Request) => (req.params as { id: string }).id;

// PLAN §7: expenses V C E D X — Owner all, Manager and Accountant VCEX (no delete).
export const expensesRouter = Router();
expensesRouter.use(requireAuth, tenant);
const view = requirePermission('expenses', 'view');

expensesRouter.get(
  '/',
  view,
  validate({ query: expenseListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.list(tenantOf(req), req.query as unknown as ExpenseListQuery);
    fetched(res, items, meta);
  }),
);

expensesRouter.get('/summary', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.summary(tenantOf(req))); }));

expensesRouter.post(
  '/',
  requirePermission('expenses', 'create'),
  validate({ body: expenseSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await svc.create(tenantOf(req), await actorOf(req), req.body as ExpenseInput, req.ip);
    if (replayed) fetched(res, result);
    else created(res, result, `Expense ${result.expenseNumber} saved`);
  }),
);

expensesRouter.get('/:id', view, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.get(tenantOf(req), idOf(req))); }));

expensesRouter.patch(
  '/:id',
  requirePermission('expenses', 'edit'),
  validate({ params: idParams, body: updateExpenseSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.update(tenantOf(req), await actorOf(req), idOf(req), req.body as UpdateExpenseInput, req.ip), 'Expense updated');
  }),
);

expensesRouter.delete(
  '/:id',
  requirePermission('expenses', 'delete'),
  validate({ params: idParams, body: deleteExpenseSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.remove(tenantOf(req), await actorOf(req), idOf(req), (req.body as { reason: string }).reason, req.ip), 'Expense removed');
  }),
);
