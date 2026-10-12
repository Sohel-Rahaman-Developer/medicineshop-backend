import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { needFeature, requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { actorOf } from '../user/actor';
import * as svc from './clinic.service';
import { bookSchema, cancelVisitSchema, chamberSchema, dayQuery, lookupQuery, moveVisitSchema, payFeeSchema, payoutSchema, sittingOffSchema, slotsQuery, visitFeeSchema, visitStatusSchema, type BookInput, type CancelVisitInput, type ChamberInput, type PayoutInput, type SittingOffInput } from './clinic.validation';

const idOf = (req: Request) => (req.params as { id: string }).id;

// D90: the doctors' chamber at the shop (Pro). The counter books and moves patients; the money to doctors is the boss's.
export const clinicRouter = Router();
clinicRouter.use(shopAuth, needFeature('clinic'));
const counter = requirePermission('pos', 'create');
const boss = requirePermission('sales', 'approve');

clinicRouter.get('/day', counter, validate({ query: dayQuery }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.dayBoard(tenantOf(req), (req.query as { day?: string }).day ?? svc.today())); }));
clinicRouter.get('/slots', counter, validate({ query: slotsQuery }), asyncHandler(async (req: Request, res: Response) => { const q = req.query as unknown as { doctorId: string; from?: string; days: number }; fetched(res, await svc.slots(tenantOf(req), q.doctorId, q.from, q.days)); }));
clinicRouter.get('/lookup', counter, validate({ query: lookupQuery }), asyncHandler(async (req: Request, res: Response) => { const q = req.query as { phone: string; doctorId?: string; day?: string }; fetched(res, await svc.lookup(tenantOf(req), q.phone, q.doctorId, q.day)); }));

clinicRouter.post(
  '/visits',
  counter,
  validate({ body: bookSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { visit, replayed } = await svc.book(tenantOf(req), await actorOf(req), req.body as BookInput, req.ip);
    const msg = `Token ${String(visit.token)} · ${visit.patient.name}`;
    if (replayed) sent(res, visit, msg);
    else created(res, visit, msg);
  }),
);
clinicRouter.post('/visits/:id/pay', counter, validate({ params: idParams, body: payFeeSchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.pay(tenantOf(req), await actorOf(req), idOf(req), (req.body as { mode: 'CASH' | 'UPI' | 'CARD' }).mode, req.ip), 'Fee paid'); }));
clinicRouter.post('/visits/:id/status', counter, validate({ params: idParams, body: visitStatusSchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.setStatus(tenantOf(req), await actorOf(req), idOf(req), (req.body as { status: 'booked' | 'arrived' | 'seen' | 'no_show' }).status, req.ip), 'Updated'); }));
clinicRouter.post('/visits/:id/cancel', counter, validate({ params: idParams, body: cancelVisitSchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.cancel(tenantOf(req), await actorOf(req), idOf(req), req.body as CancelVisitInput, req.ip), 'Appointment cancelled'); }));
clinicRouter.post('/visits/:id/move', counter, validate({ params: idParams, body: moveVisitSchema }), asyncHandler(async (req: Request, res: Response) => { const v = await svc.move(tenantOf(req), await actorOf(req), idOf(req), req.body as { day: string; start: string }, req.ip); sent(res, v, `Moved · token ${String(v.token)}`); }));
clinicRouter.post('/visits/:id/fee', counter, validate({ params: idParams, body: visitFeeSchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.setFee(tenantOf(req), await actorOf(req), idOf(req), req.body as { kind: 'new' | 'followup'; fee: number }, req.ip), 'Fee changed'); }));

clinicRouter.post('/off', requirePermission('customers', 'edit'), validate({ body: sittingOffSchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.sittingOff(tenantOf(req), await actorOf(req), req.body as SittingOffInput, req.ip), 'Sitting marked off'); }));
clinicRouter.post('/on', requirePermission('customers', 'edit'), validate({ body: sittingOffSchema }), asyncHandler(async (req: Request, res: Response) => { await svc.sittingOn(tenantOf(req), await actorOf(req), req.body as SittingOffInput, req.ip); sent(res, { ok: true }, 'Sitting open again'); }));

clinicRouter.put('/doctors/:id/chamber', requirePermission('settings', 'edit'), validate({ params: idParams, body: chamberSchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.saveChamber(tenantOf(req), await actorOf(req), idOf(req), req.body as ChamberInput, req.ip), 'Chamber saved'); }));

clinicRouter.get('/dues', boss, asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.dues(tenantOf(req))); }));
clinicRouter.get('/dues/:id', boss, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.account(tenantOf(req), idOf(req))); }));
clinicRouter.post(
  '/payouts',
  boss,
  validate({ body: payoutSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { payout, replayed } = await svc.payout(tenantOf(req), await actorOf(req), req.body as PayoutInput, req.ip);
    if (replayed) sent(res, payout, 'Paid');
    else created(res, payout, `Paid ${payout.doctorName}`);
  }),
);
