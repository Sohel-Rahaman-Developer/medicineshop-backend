import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import { LIMIT, idParams, objectId } from '../../core/zod';
import { ADMIN_ROLES } from './admin.model';
import { adminOf, clearPin, lockNow, meOf, requestCode, requireAdmin, requireAdminRole, setPin, signOut, unlock, verifyCode, verifyTotp } from './admin-auth';
import { otpVerifyLimiter } from '../../core/middleware/rate-limit';
import { AdminAuditModel } from './admin.model';
import { Types } from 'mongoose';
import * as svc from './admin.service';
import { platform } from './platform';
import * as support from './support';
import { sendFilesZip } from '../attachments/files-zip';
import { requireAuth } from '../../core/middleware/require-auth';
import { tenant, tenantOf } from '../../core/middleware/tenant';
import { actorOf } from '../user/actor';
import { istDay } from '../../core/zod';
import { CHANGELOG } from '../release/changelog';
import { release } from '../release/release';
import * as ai from '../ai/ai-admin';
import { aiSettingsSchema, type AiSettingsInput } from '../ai/ai-settings';
import { referralSettingsSchema, type ReferralSettings } from '../referral/referral.service';

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

adminRouter.post('/auth/lock', asyncHandler(async (req: Request, res: Response) => { await lockNow(req); sent(res, { locked: true }, 'Locked'); }));
adminRouter.post('/auth/unlock', otpVerifyLimiter, validate({ body: z.object({ pin: z.string().regex(/^\d{4,6}$/).optional(), code: z.string().regex(/^\d{6}$/).optional() }).strict().refine((b) => Boolean(b.pin) !== Boolean(b.code), 'Send a PIN or an authenticator code') }), asyncHandler(async (req: Request, res: Response) => { sent(res, await unlock(req, res, req.body as { pin?: string; code?: string }), 'Unlocked'); }));

adminRouter.use(requireAdmin);
const shopsRole = requireAdminRole('super', 'support');
const moneyRole = requireAdminRole('super', 'accounts');
const superOnly = requireAdminRole('super');

adminRouter.get('/me', asyncHandler(async (req: Request, res: Response) => { fetched(res, await meOf(adminOf(req).id)); }));
adminRouter.put('/me/pin', otpVerifyLimiter, validate({ body: z.object({ pin: z.string().regex(/^\d{4,6}$/, 'PIN is 4 to 6 digits'), code: z.string().regex(/^\d{6}$/, 'Six digits from your authenticator') }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  const a = adminOf(req);
  const b = req.body as { pin: string; code: string };
  await setPin(a.id, b.pin, b.code);
  await AdminAuditModel.create({ adminUserId: new Types.ObjectId(a.id), adminName: a.name, action: 'pin_set', reason: 'own quick-unlock PIN', text: 'set a quick-unlock PIN', ip: req.ip });
  sent(res, await meOf(a.id), 'PIN saved');
}));
adminRouter.delete('/me/pin', asyncHandler(async (req: Request, res: Response) => {
  const a = adminOf(req);
  await clearPin(a.id);
  await AdminAuditModel.create({ adminUserId: new Types.ObjectId(a.id), adminName: a.name, action: 'pin_cleared', reason: 'own quick-unlock PIN', text: 'removed the quick-unlock PIN', ip: req.ip });
  sent(res, await meOf(a.id), 'PIN removed');
}));
adminRouter.get('/overview', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.overview()); }));
adminRouter.get('/shops', validate({ query: listQuery }), asyncHandler(async (req: Request, res: Response) => { const r = await svc.shops(req.query as unknown as { q?: string; status?: string; cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.get('/shops/:id', validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.shop((req.params as { id: string }).id)); }));
adminRouter.post('/shops/:id/status', shopsRole, validate({ params: idParams, body: z.object({ status: z.enum(['active', 'suspended']), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { status: 'active' | 'suspended'; reason: string }; await svc.setStatus(adminOf(req), (req.params as { id: string }).id, b.status, b.reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), b.status === 'suspended' ? 'Shop suspended' : 'Shop turned back on'); }));
adminRouter.post('/shops/:id/extend', shopsRole, validate({ params: idParams, body: z.object({ days: z.number().int().min(1).max(60), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { days: number; reason: string }; await svc.extend(adminOf(req), (req.params as { id: string }).id, b.days, b.reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), `${String(b.days)} days added`); }));

adminRouter.get('/payments', moneyRole, validate({ query: payQuery }), asyncHandler(async (req: Request, res: Response) => { const r = await svc.payments(req.query as unknown as { status?: string; cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.post('/payments/:id/refund', moneyRole, validate({ params: idParams, body: z.object({ amount: z.number().int().min(100).max(10_000_000), removeDays: z.boolean(), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.refundPayment(adminOf(req), (req.params as { id: string }).id, req.body as { amount: number; removeDays: boolean; reason: string }, req.ip), 'Refund sent'); }));
adminRouter.post('/shops/:id/autopay/stop', moneyRole, validate({ params: idParams, body: z.object({ reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { await svc.stopShopAutopay(adminOf(req), (req.params as { id: string }).id, (req.body as { reason: string }).reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), 'Autopay stopped'); }));
adminRouter.post('/payments/manual', moneyRole, validate({ body: z.object({ shopId: objectId, planCode: z.string().min(2).max(20), reference: z.string().trim().min(3).max(80), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.manualPayment(adminOf(req), req.body as { shopId: string; planCode: string; reference: string; reason: string }, req.ip), 'Payment recorded'); }));

adminRouter.put('/plans', superOnly, validate({ body: z.object({ plans: z.array(planSchema).min(1).max(6), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { plans: z.infer<typeof planSchema>[]; reason: string }; sent(res, await svc.setPlans(adminOf(req), b.plans, b.reason, req.ip), 'Plans saved'); }));
adminRouter.get('/settings', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.settings()); }));
adminRouter.put('/settings', superOnly, validate({ body: z.object({ settings: settingsSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { settings: z.infer<typeof settingsSchema>; reason: string }; sent(res, await svc.saveSettings(adminOf(req), b.settings, b.reason, req.ip), 'Platform settings saved'); }));

// D78: AI bill reading — settings and the key are super's; coins by hand are accounts'; usage is for every role.
const readsQuery = z.object({ shopId: objectId.optional(), status: z.enum(['running', 'done', 'failed']).optional(), cursor: z.string().max(400).optional(), limit: LIMIT }).strict();
adminRouter.get('/ai', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await ai.aiOverview()); }));
adminRouter.get('/ai/reads', validate({ query: readsQuery }), asyncHandler(async (req: Request, res: Response) => { const r = await ai.aiReads(req.query as unknown as { shopId?: string; status?: string; cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.get('/ai/orders', moneyRole, validate({ query: z.object({ cursor: z.string().max(400).optional(), limit: LIMIT }).strict() }), asyncHandler(async (req: Request, res: Response) => { const r = await ai.coinOrders(req.query as unknown as { cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.put('/ai/settings', superOnly, validate({ body: z.object({ settings: aiSettingsSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { settings: AiSettingsInput; reason: string }; sent(res, await ai.updateAiSettings(adminOf(req), b.settings, b.reason, req.ip), 'AI settings saved'); }));
adminRouter.put('/ai/key', superOnly, validate({ body: z.object({ apiKey: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,200}$/, 'An Anthropic API key starts with sk-ant-'), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { apiKey: string; reason: string }; sent(res, await ai.updateApiKey(adminOf(req), b.apiKey, b.reason, req.ip), 'API key saved'); }));
adminRouter.delete('/ai/key', superOnly, validate({ body: z.object({ reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await ai.updateApiKey(adminOf(req), null, (req.body as { reason: string }).reason, req.ip), 'API key removed — AI reading is off'); }));
adminRouter.post('/ai/key/test', superOnly, asyncHandler(async (_req: Request, res: Response) => { const r = await ai.testApiKey(); sent(res, r, r.message); }));
adminRouter.get('/shops/:id/coins', validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await ai.shopCoins((req.params as { id: string }).id)); }));
adminRouter.post('/shops/:id/coins', moneyRole, validate({ params: idParams, body: z.object({ coins: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, 'Give or take at least 1 coin'), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { coins: number; reason: string }; sent(res, await ai.grantCoins(adminOf(req), (req.params as { id: string }).id, b.coins, b.reason, req.ip), b.coins > 0 ? `${String(b.coins)} coins added` : `${String(-b.coins)} coins taken back`); }));

// D80: referral program — the terms are super's; who referred a shop is support's (shops role).
adminRouter.get('/referrals', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.referrals()); }));
adminRouter.put('/referrals/settings', superOnly, validate({ body: z.object({ settings: referralSettingsSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { settings: ReferralSettings; reason: string }; sent(res, await svc.saveReferral(adminOf(req), b.settings, b.reason, req.ip), 'Referral settings saved'); }));
adminRouter.put('/shops/:id/referrer', shopsRole, validate({ params: idParams, body: z.object({ referrerShopId: objectId.nullable(), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { referrerShopId: string | null; reason: string }; await svc.setReferrer(adminOf(req), (req.params as { id: string }).id, b.referrerShopId, b.reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), b.referrerShopId ? 'Referrer saved' : 'Referrer removed'); }));

adminRouter.get('/team', superOnly, asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.team()); }));
adminRouter.post('/team', superOnly, validate({ body: z.object({ email, name: z.string().trim().min(2).max(80), role: z.enum(ADMIN_ROLES), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { email: string; name: string; role: (typeof ADMIN_ROLES)[number]; reason: string }; sent(res, await svc.invite(adminOf(req), b, b.reason, req.ip), `${b.name} added`); }));
adminRouter.patch('/team/:id', superOnly, validate({ params: idParams, body: z.object({ role: z.enum(ADMIN_ROLES).optional(), status: z.enum(['active', 'disabled']).optional(), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { role?: (typeof ADMIN_ROLES)[number]; status?: 'active' | 'disabled'; reason: string }; sent(res, await svc.setMember(adminOf(req), (req.params as { id: string }).id, { ...(b.role ? { role: b.role } : {}), ...(b.status ? { status: b.status } : {}) }, b.reason, req.ip), 'Saved'); }));

adminRouter.put('/shops/:id/prices', moneyRole, validate({ params: idParams, body: z.object({ prices: z.array(z.object({ code: z.string().min(2).max(20), price: z.number().int().min(100).max(10_000_000).nullable() }).strict()).min(1).max(6), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { prices: { code: string; price: number | null }[]; reason: string }; await svc.setShopPrices(adminOf(req), (req.params as { id: string }).id, b.prices, b.reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), 'Price saved'); }));
adminRouter.get('/shops/:id/retention', validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.retentionOf((req.params as { id: string }).id)); }));
adminRouter.put('/shops/:id/retention', moneyRole, validate({ params: idParams, body: z.object({ tier: z.enum(['legal', 'y10']), legalHold: z.boolean(), legalHoldReason: z.string().trim().max(200), reason }).strict().refine((v) => !v.legalHold || v.legalHoldReason.length >= 3, { message: 'Name the case for a legal hold', path: ['legalHoldReason'] }) }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { tier: 'legal' | 'y10'; legalHold: boolean; legalHoldReason: string; reason: string }; sent(res, await svc.setRetention(adminOf(req), (req.params as { id: string }).id, b, req.ip), 'Data settings saved'); }));
adminRouter.get('/health', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.health()); }));
adminRouter.get('/release', (_req: Request, res: Response) => { fetched(res, { ...release(), notes: CHANGELOG }); });

// SANDBOX A16: support asks, the owner decides in the shop app, then read-only reports for the hours given.
adminRouter.post('/shops/:id/support', shopsRole, validate({ params: idParams, body: z.object({ hours: z.union([z.literal(1), z.literal(4), z.literal(24)]), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { hours: number; reason: string }; sent(res, await support.request(adminOf(req), (req.params as { id: string }).id, b.hours, b.reason, req.ip), 'Request sent to the owner'); }));
adminRouter.get('/support', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await support.forAdmin()); }));
adminRouter.get(
  '/support/:id/r/:key',
  shopsRole,
  validate({ params: z.object({ id: objectId, key: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(), query: z.object({ from: istDay.optional(), to: istDay.optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from?: Date; to?: Date; month?: string };
    const p = req.params as { id: string; key: string };
    const now = new Date();
    fetched(res, await support.runReport(adminOf(req), p.id, p.key, { from: q.from ?? new Date(now.getTime() - 29 * 86_400_000), to: q.to ?? now, month: q.month ?? new Date(now.getTime() + 19_800_000).toISOString().slice(0, 7) }, req.ip));
  }),
);

adminRouter.get('/support/:id/files.zip', shopsRole, validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { const r = await support.filesZip(adminOf(req), (req.params as { id: string }).id, req.ip); await sendFilesZip(res, r.shopId, r); }));

adminRouter.get('/audit', validate({ query: z.object({ cursor: z.string().max(400).optional(), limit: LIMIT }).strict() }), asyncHandler(async (req: Request, res: Response) => { const r = await svc.auditLog(req.query as unknown as { cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));

/** Public: the shop app shows the maintenance banner and support contacts from here. */
export const platformRouter = Router();
platformRouter.get('/', asyncHandler(async (_req: Request, res: Response) => { const p = await platform(); fetched(res, { maintenance: p.maintenance, supportEmail: p.supportEmail, supportPhone: p.supportPhone }); }));

/** Shop side (owner): see MedShop's requests, approve / deny / stop. */
export const supportAccessRouter = Router();
supportAccessRouter.use(requireAuth, tenant);
supportAccessRouter.get('/', asyncHandler(async (req: Request, res: Response) => { fetched(res, await support.forShop(tenantOf(req))); }));
supportAccessRouter.post('/:id/:decision', validate({ params: z.object({ id: objectId, decision: z.enum(['approve', 'deny', 'revoke']) }).strict() }), asyncHandler(async (req: Request, res: Response) => { const p = req.params as { id: string; decision: 'approve' | 'deny' | 'revoke' }; sent(res, await support.decide(tenantOf(req), await actorOf(req), p.id, p.decision, req.ip), p.decision === 'approve' ? 'Access given' : p.decision === 'deny' ? 'Request denied' : 'Access stopped'); }));
