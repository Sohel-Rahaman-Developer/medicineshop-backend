import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { needFeature, notInDemo, requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { sendFile } from '../../core/export';
import { payslipPdf } from './payroll.pdf';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import type { DayBasis } from './payroll.model';
import * as svc from './payroll.service';
import { advanceSchema, bonusSchema, dayQuery, employeeSchema, markSchema, monthQuery, paySchema, pfSchema, removeSchema, settingsSchema, type AdvanceInput, type BonusInput, type EmployeeInput, type MarkInput, type PayInput, type PfInput } from './payroll.validation';

// D114 payroll (Pro): the Owner by default; anyone else only with Payroll given in their role or grants.
export const payrollRouter = Router();
payrollRouter.use(shopAuth, needFeature('payroll'));
const view = requirePermission('payroll', 'view');
const add = requirePermission('payroll', 'create');
const edit = requirePermission('payroll', 'edit');
const undo = requirePermission('payroll', 'delete');
const idOf = (req: Request) => (req.params as { id: string }).id;

payrollRouter.get('/settings', view, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.settings(tenantOf(req))); }));
payrollRouter.put('/settings', edit, validate({ body: settingsSchema }), asyncHandler(async (req: Request, res: Response) => {
  sent(res, await svc.saveSettings(tenantOf(req), await actorOf(req), (req.body as { dayBasis: DayBasis }).dayBasis, req.ip), 'Payroll settings saved');
}));

payrollRouter.get('/month', view, validate({ query: monthQuery }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.month(tenantOf(req), (req.query as unknown as { month: string }).month)); }));
payrollRouter.get('/day', view, validate({ query: dayQuery }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.day(tenantOf(req), (req.query as unknown as { day: string }).day)); }));
payrollRouter.put('/attendance', add, validate({ body: markSchema }), asyncHandler(async (req: Request, res: Response) => {
  sent(res, await svc.mark(tenantOf(req), await actorOf(req), req.body as MarkInput, new Date(), req.ip), 'Attendance saved');
}));

payrollRouter.post('/employees', add, validate({ body: employeeSchema }), asyncHandler(async (req: Request, res: Response) => {
  const e = await svc.createEmployee(tenantOf(req), await actorOf(req), req.body as EmployeeInput, req.ip);
  created(res, e, `${e.name} added`);
}));
payrollRouter.get('/employees/:id/month', view, validate({ params: idParams, query: monthQuery }), asyncHandler(async (req: Request, res: Response) => {
  fetched(res, await svc.personMonth(tenantOf(req), idOf(req), (req.query as unknown as { month: string }).month));
}));
payrollRouter.put('/employees/:id', edit, validate({ params: idParams, body: employeeSchema }), asyncHandler(async (req: Request, res: Response) => {
  const e = await svc.updateEmployee(tenantOf(req), await actorOf(req), idOf(req), req.body as EmployeeInput, req.ip);
  sent(res, e, `${e.name} saved`);
}));
payrollRouter.delete('/employees/:id', undo, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  const e = await svc.removeEmployee(tenantOf(req), await actorOf(req), idOf(req), req.ip);
  sent(res, e, `${e.name} removed`);
}));

const money = (path: string, schema: Parameters<typeof validate>[0]['body'], run: (req: Request) => Promise<{ result: unknown; replayed: boolean }>, message: string) => {
  payrollRouter.post(path, add, validate({ body: schema }), asyncHandler(async (req: Request, res: Response) => {
    const { result, replayed } = await run(req);
    if (replayed) fetched(res, result);
    else created(res, result, message);
  }));
};
money('/advances', advanceSchema, async (req) => svc.advance(tenantOf(req), await actorOf(req), req.body as AdvanceInput, new Date(), req.ip), 'Advance saved');
money('/bonuses', bonusSchema, async (req) => svc.bonus(tenantOf(req), await actorOf(req), req.body as BonusInput, new Date(), req.ip), 'Bonus saved');
money(
  '/pay',
  paySchema,
  async (req) => {
    const actor = await actorOf(req);
    const r = await svc.pay(tenantOf(req), actor, req.body as PayInput, new Date(), req.ip);
    if (r.replayed) return r;
    const mailed = await svc.mailIfEmail(tenantOf(req), actor, r.result.id, req.ip);
    return { ...r, result: { ...r.result, mailedTo: mailed?.mailedTo ?? null, mailedAt: mailed?.mailedAt ?? null } };
  },
  'Salary paid',
);
money('/pf', pfSchema, async (req) => svc.depositPf(tenantOf(req), await actorOf(req), req.body as PfInput, new Date(), req.ip), 'PF deposit saved');

payrollRouter.get('/entries/:id/pdf', view, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  const { pdf, name } = await payslipPdf(tenantOf(req), idOf(req));
  sendFile(res, pdf, name, 'pdf');
}));
payrollRouter.post('/entries/:id/email', add, notInDemo, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  const r = await svc.mailPayslip(tenantOf(req), await actorOf(req), idOf(req), req.ip);
  sent(res, r, `Payslip emailed to ${r.mailedTo}`);
}));
payrollRouter.delete('/entries/:id', undo, validate({ params: idParams, body: removeSchema }), asyncHandler(async (req: Request, res: Response) => {
  sent(res, await svc.removeEntry(tenantOf(req), await actorOf(req), idOf(req), (req.body as { reason: string }).reason, req.ip), 'Undone');
}));
