import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { LIMIT, idParams, objectId } from '../../core/zod';
import { ADMIN_ROLES } from './admin.model';
import { adminOf, requestCode, requireAdmin, requireAdminRole, signOut, verifyCode, verifyTotp } from './admin-auth';
import * as svc from './admin.service';
import { platform } from './platform';

const email = z.email('Enter a valid email').max(160);
/** SECURITY §6 (B9): an admin action without a reason is refused. */
const reason = z.string().trim().min(5, 'Say why (5 letters at least)').max(300);
const listQuery = z.object({ q: z.string().trim().max(80).optional(), status: z.enum(['trial', 'active', 'grace', 'expired', 'cancelled', 'suspended']).optional(), cursor: z.string().max(400).optional(), limit: LIMIT }).strict();
const payQuery = z.object({ status: z.enum(['paid', 'failed']).optional(), cursor: z.string().max(400).optional(), limit: LIMIT }).strict();
const planSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9-]{1,19}$/), name: z.string().trim().min(2).max(40), price: z.number().int().min(100).max(10_000_000), durationDays: z.number().int().min(1).max(1100), maxUsers: z.number().int().min(1).max(200), isActive: z.boolean() }).strict();
const settingsSchema = z
  .object({
    trialDays: z.number().int().min(1).max(90),
    trialMaxUsers: z.number().int().min(1).max(50),
    graceDays: z.number().int().min(0).max(30),
    supportEmail: z.union([z.literal(''), z.email()]),
    supportPhone: z.string().trim().max(20),
    maintenance: z.object({ on: z.boolean(), message: z.string().trim().max(200) }).strict(),
  })
  .strict();

// PLAN §21.1 / SECURITY §3: the platform console. Roles — super: everything; support: shops; accounts: money; viewer: read.
export const adminRouter = Router();

adminRouter.post('/auth/code', validate({ body: z.object({ email }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await requestCode((req.body as { email: string }).email, req.ip), 'If this address is on the platform team, a code is on its way'); }));
adminRouter.post('/auth/verify', validate({ body: z.object({ email, otp: z.string().regex(/^\d{4,8}$/) }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { email: string; otp: string }; fetched(res, await verifyCode(req, res, b.email, b.otp)); }));
adminRouter.post('/auth/totp', validate({ body: z.object({ code: z.string().regex(/^\d{6}$/, 'Six digits from your authenticator') }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await verifyTotp(req, res, (req.body as { code: string }).code), 'Signed in'); }));
adminRouter.post('/auth/logout', asyncHandler(async (req: Request, res: Response) => { await signOut(req, res); sent(res, { ok: true }, 'Signed out'); }));

adminRouter.use(requireAdmin);
const shopsRole = requireAdminRole('super', 'support');
const moneyRole = requireAdminRole('super', 'accounts');
const superOnly = requireAdminRole('super');

adminRouter.get('/me', (req: Request, res: Response) => { fetched(res, adminOf(req)); });
adminRouter.get('/overview', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.overview()); }));
adminRouter.get('/shops', validate({ query: listQuery }), asyncHandler(async (req: Request, res: Response) => { const r = await svc.shops(req.query as unknown as { q?: string; status?: string; cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.get('/shops/:id', validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.shop((req.params as { id: string }).id)); }));
adminRouter.post('/shops/:id/status', shopsRole, validate({ params: idParams, body: z.object({ status: z.enum(['active', 'suspended']), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { status: 'active' | 'suspended'; reason: string }; await svc.setStatus(adminOf(req), (req.params as { id: string }).id, b.status, b.reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), b.status === 'suspended' ? 'Shop suspended' : 'Shop turned back on'); }));
adminRouter.post('/shops/:id/extend', shopsRole, validate({ params: idParams, body: z.object({ days: z.number().int().min(1).max(60), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { days: number; reason: string }; await svc.extend(adminOf(req), (req.params as { id: string }).id, b.days, b.reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), `${String(b.days)} days added`); }));

adminRouter.get('/payments', moneyRole, validate({ query: payQuery }), asyncHandler(async (req: Request, res: Response) => { const r = await svc.payments(req.query as unknown as { status?: string; cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.post('/payments/manual', moneyRole, validate({ body: z.object({ shopId: objectId, planCode: z.string().min(2).max(20), reference: z.string().trim().min(3).max(80), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.manualPayment(adminOf(req), req.body as { shopId: string; planCode: string; reference: string; reason: string }, req.ip), 'Payment recorded'); }));

adminRouter.put('/plans', superOnly, validate({ body: z.object({ plans: z.array(planSchema).min(1).max(6), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { plans: z.infer<typeof planSchema>[]; reason: string }; sent(res, await svc.setPlans(adminOf(req), b.plans, b.reason, req.ip), 'Plans saved'); }));
adminRouter.get('/settings', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.settings()); }));
adminRouter.put('/settings', superOnly, validate({ body: z.object({ settings: settingsSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { settings: z.infer<typeof settingsSchema>; reason: string }; sent(res, await svc.saveSettings(adminOf(req), b.settings, b.reason, req.ip), 'Platform settings saved'); }));

adminRouter.get('/team', superOnly, asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.team()); }));
adminRouter.post('/team', superOnly, validate({ body: z.object({ email, name: z.string().trim().min(2).max(80), role: z.enum(ADMIN_ROLES), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { email: string; name: string; role: (typeof ADMIN_ROLES)[number]; reason: string }; sent(res, await svc.invite(adminOf(req), b, b.reason, req.ip), `${b.name} added`); }));
adminRouter.patch('/team/:id', superOnly, validate({ params: idParams, body: z.object({ role: z.enum(ADMIN_ROLES).optional(), status: z.enum(['active', 'disabled']).optional(), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { role?: (typeof ADMIN_ROLES)[number]; status?: 'active' | 'disabled'; reason: string }; sent(res, await svc.setMember(adminOf(req), (req.params as { id: string }).id, { ...(b.role ? { role: b.role } : {}), ...(b.status ? { status: b.status } : {}) }, b.reason, req.ip), 'Saved'); }));

adminRouter.get('/audit', validate({ query: z.object({ cursor: z.string().max(400).optional(), limit: LIMIT }).strict() }), asyncHandler(async (req: Request, res: Response) => { const r = await svc.auditLog(req.query as unknown as { cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));

/** Public: the shop app shows the maintenance banner and support contacts from here. */
export const platformRouter = Router();
platformRouter.get('/', asyncHandler(async (_req: Request, res: Response) => { const p = await platform(); fetched(res, { maintenance: p.maintenance, supportEmail: p.supportEmail, supportPhone: p.supportPhone }); }));
