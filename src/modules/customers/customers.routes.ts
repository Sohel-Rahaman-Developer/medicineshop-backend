import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as svc from './customers.service';
import { collectSchema, customerListSchema, customerSchema, doctorSchema, updateCustomerSchema, type CollectInput, type CustomerInput, type CustomerListQuery, type DoctorInput, type UpdateCustomerInput } from './customers.validation';

const idOf = (req: Request) => (req.params as { id: string }).id;

// PLAN §7: customers V C E D X; collecting udhaar and the limit need edit (sandbox people.js).
export const customersRouter = Router();
customersRouter.use(shopAuth);
const view = requirePermission('customers', 'view');
const edit = requirePermission('customers', 'edit');

customersRouter.get(
  '/',
  view,
  validate({ query: customerListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await svc.list(tenantOf(req), req.query as unknown as CustomerListQuery);
    fetched(res, items, meta);
  }),
);

customersRouter.get('/summary', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.summary(tenantOf(req))); }));

customersRouter.post(
  '/',
  requirePermission('customers', 'create'),
  validate({ body: customerSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const c = await svc.create(tenantOf(req), await actorOf(req), req.body as CustomerInput, req.ip);
    created(res, c, `${c.name} added`);
  }),
);

customersRouter.get('/:id', view, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.get(tenantOf(req), idOf(req))); }));

customersRouter.put(
  '/:id',
  edit,
  validate({ params: idParams, body: updateCustomerSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const c = await svc.update(tenantOf(req), await actorOf(req), idOf(req), req.body as UpdateCustomerInput, req.ip);
    sent(res, c, `${c.name} saved`);
  }),
);

customersRouter.get('/:id/ledger', view, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.ledger(tenantOf(req), idOf(req))); }));

customersRouter.post(
  '/:id/payments',
  edit,
  validate({ params: idParams, body: collectSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await svc.collect(tenantOf(req), await actorOf(req), idOf(req), req.body as CollectInput, req.ip);
    const msg = `${result.receiptNumber} · ${result.amount / 100} collected`;
    if (replayed) sent(res, result, msg);
    else created(res, result, msg);
  }),
);

export const doctorsRouter = Router();
doctorsRouter.use(shopAuth);

// The counter picks a doctor on an H1 bill, so POS users read the list too.
doctorsRouter.get(
  '/',
  requirePermission('pos', 'view'),
  validate({ query: z.object({ q: z.string().trim().max(60).optional() }).strict() }),
  asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.doctors(tenantOf(req), (req.query as { q?: string }).q)); }),
);

doctorsRouter.post(
  '/',
  requirePermission('customers', 'create'),
  validate({ body: doctorSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const d = await svc.addDoctor(tenantOf(req), await actorOf(req), req.body as DoctorInput, req.ip);
    created(res, d, `${d.name} added`);
  }),
);
