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
import { shopAuth, tenantOf } from '../../core/middleware/tenant';
import { actorOf } from '../user/actor';
import { istDay } from '../../core/zod';
import { CHANGELOG } from '../release/changelog';
import { release } from '../release/release';
import * as ai from '../ai/ai-admin';
import * as gw from './gateway-admin';
import { perfOverview } from '../perf/perf';
import { aiBill, aiMoney } from '../ai/ledger';
import * as credit from '../ai/credits';
import { AI_MODEL_IDS, AI_PROVIDERS, type AiProvider } from '../ai/ai.model';
import { GATEWAY_ACTIVE, GATEWAY_SETS, type BillingInput, type GatewayActive, type GatewaySet, type KeysInput } from '../subscription/gateway';
import { STATES } from '../../utils/india';
import { aiSettingsSchema, chatSettingsSchema, pricesSchema, type AiSettingsInput, type ChatSettingsInput, type PricesInput } from '../ai/ai-settings';
import * as chat from '../ask/ask-admin';
import * as categories from '../categories/categories.service';
import { ASK_ROUTES } from '../ask/ask.model';
import { referralSettingsSchema, type ReferralSettings } from '../referral/referral.service';
import * as brand from '../branding/branding.service';
import * as demo from '../demo/demo.service';
import { FEATURES, TIERS } from '../subscription/features';
import { allPlans } from '../subscription/subscription.service';

const email = z.email('Enter a valid email').max(160);
/** SECURITY §6 (B9): an admin action without a reason is refused. */
const reason = z.string().trim().min(5, 'Say why (5 letters at least)').max(300);
const listQuery = z.object({ q: z.string().trim().max(80).optional(), status: z.enum(['trial', 'active', 'grace', 'expired', 'cancelled', 'suspended']).optional(), cursor: z.string().max(400).optional(), limit: LIMIT }).strict();
const payQuery = z.object({ status: z.enum(['paid', 'failed']).optional(), cursor: z.string().max(400).optional(), limit: LIMIT }).strict();
const planSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9-]{1,19}$/), name: z.string().trim().min(2).max(40), price: z.number().int().min(100).max(10_000_000), durationDays: z.number().int().min(1).max(1100), maxUsers: z.number().int().min(1).max(200), isActive: z.boolean(), tier: z.enum(TIERS), features: z.array(z.enum(FEATURES)).max(FEATURES.length).refine((f) => new Set(f).size === f.length, 'Each module once') }).strict();
const settingsSchema = z
  .object({
    trialDays: z.number().int().min(1).max(90),
    trialMaxUsers: z.number().int().min(1).max(50),
    graceDays: z.number().int().min(0).max(30),
    supportEmail: z.union([z.literal(''), z.email()]),
    supportPhone: z.string().trim().max(20),
    legalName: z.string().trim().max(120).default(''),
    address: z.string().trim().max(300).default(''),
    grievanceOfficer: z.string().trim().max(80).default(''),
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

adminRouter.get('/plans', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await allPlans()); }));
adminRouter.put('/plans', superOnly, validate({ body: z.object({ plans: z.array(planSchema).min(1).max(8).refine((l) => new Set(l.map((p) => p.code)).size === l.length, 'Each plan code once'), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { plans: z.infer<typeof planSchema>[]; reason: string }; sent(res, await svc.setPlans(adminOf(req), b.plans, b.reason, req.ip), 'Plans saved'); }));
adminRouter.get('/settings', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.settings()); }));
adminRouter.put('/settings', superOnly, validate({ body: z.object({ settings: settingsSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { settings: z.infer<typeof settingsSchema>; reason: string }; sent(res, await svc.saveSettings(adminOf(req), b.settings, b.reason, req.ip), 'Platform settings saved'); }));

// D78: AI bill reading — settings and the key are super's; coins by hand are accounts'; usage is for every role.
const readsQuery = z.object({ shopId: objectId.optional(), status: z.enum(['running', 'done', 'failed']).optional(), cursor: z.string().max(400).optional(), limit: LIMIT }).strict();
adminRouter.get('/ai', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await ai.aiOverview()); }));
adminRouter.get('/ai/reads', validate({ query: readsQuery }), asyncHandler(async (req: Request, res: Response) => { const r = await ai.aiReads(req.query as unknown as { shopId?: string; status?: string; cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.get('/ai/orders', moneyRole, validate({ query: z.object({ cursor: z.string().max(400).optional(), limit: LIMIT }).strict() }), asyncHandler(async (req: Request, res: Response) => { const r = await ai.coinOrders(req.query as unknown as { cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.put('/ai/settings', superOnly, validate({ body: z.object({ settings: aiSettingsSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { settings: AiSettingsInput; reason: string }; sent(res, await ai.updateAiSettings(adminOf(req), b.settings, b.reason, req.ip), 'AI settings saved'); }));
// The status card: one tap on or off; a model or coins only when that is the fix it offers.
const switchBody = z.object({ feature: z.enum(['read', 'chat']), on: z.boolean(), model: z.enum(AI_MODEL_IDS).optional(), coins: z.number().int().min(1).max(100).optional(), reason }).strict().refine((b) => b.feature === 'read' || (b.coins ?? 1) <= 20, { message: 'A chat question costs 20 tokens at most', path: ['coins'] });
adminRouter.post('/ai/switch', superOnly, validate({ body: switchBody }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as z.infer<typeof switchBody>; sent(res, await ai.switchAi(adminOf(req), b, b.reason, req.ip), b.on ? 'Turned on' : 'Turned off'); }));
adminRouter.put('/ai/key', superOnly, validate({ body: z.object({ apiKey: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,200}$/, 'An Anthropic API key starts with sk-ant-'), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { apiKey: string; reason: string }; sent(res, await ai.updateApiKey(adminOf(req), b.apiKey, b.reason, req.ip), 'API key saved'); }));
adminRouter.delete('/ai/key', superOnly, validate({ body: z.object({ reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await ai.updateApiKey(adminOf(req), null, (req.body as { reason: string }).reason, req.ip), 'API key removed — AI reading is off'); }));
adminRouter.post('/ai/key/test', superOnly, asyncHandler(async (_req: Request, res: Response) => { const r = await ai.testApiKey(); sent(res, r, r.message); }));
// D96: the Gemini key — Google's older keys start with AIza, its auth keys (from 2026) with AQ.
adminRouter.put('/ai/gemini-key', superOnly, validate({ body: z.object({ apiKey: z.string().trim().regex(/^(AIza[A-Za-z0-9_-]{30,80}|AQ\.[A-Za-z0-9_-]{20,200})$/, 'A Gemini API key starts with AIza or AQ.'), paid: z.boolean(), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { apiKey: string; paid: boolean; reason: string }; sent(res, await ai.updateApiKey(adminOf(req), b.apiKey, b.reason, req.ip, 'google', b.paid), 'Gemini key saved'); }));
adminRouter.delete('/ai/gemini-key', superOnly, validate({ body: z.object({ reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await ai.updateApiKey(adminOf(req), null, (req.body as { reason: string }).reason, req.ip, 'google'), 'Gemini key removed'); }));
adminRouter.put('/ai/gemini-key/billing', superOnly, validate({ body: z.object({ paid: z.boolean(), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { paid: boolean; reason: string }; sent(res, await ai.updateGeminiBilling(adminOf(req), b.paid, b.reason, req.ip), b.paid ? 'Billing on' : 'Billing off'); }));
adminRouter.post('/ai/gemini-key/test', superOnly, asyncHandler(async (_req: Request, res: Response) => { const r = await ai.testApiKey('google'); sent(res, r, r.message); }));
// D81: the shop chat — its caps, prices and use.
const questionsQuery = z.object({ shopId: objectId.optional(), route: z.enum(ASK_ROUTES).optional(), cursor: z.string().max(400).optional(), limit: LIMIT }).strict();
// D97: is every AI price safe, the real margin, and what each shop (and who in it) spends against what it paid.
adminRouter.get('/ai/money', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await aiMoney()); }));
adminRouter.get('/ai/bill', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await aiBill()); }));
// D97: the admin writes down each top-up at Anthropic / Google; the estimate and the low-credit email follow from it.
const providerParam = z.object({ provider: z.enum(AI_PROVIDERS) }).strict();
adminRouter.get('/ai/credits', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await credit.credits()); }));
adminRouter.post('/ai/credits/:provider', moneyRole, validate({ params: providerParam, body: z.object({ usd: z.number().min(1).max(100_000), at: istDay.optional(), note: z.string().trim().max(120).default(''), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { usd: number; at?: Date; note: string; reason: string }; sent(res, await credit.addTopup(adminOf(req), (req.params as { provider: AiProvider }).provider, b, b.reason, req.ip), 'Top-up added'); }));
adminRouter.put('/ai/credits/:provider/alert', moneyRole, validate({ params: providerParam, body: z.object({ alertUsd: z.number().min(0).max(10_000), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { alertUsd: number; reason: string }; sent(res, await credit.setAlert(adminOf(req), (req.params as { provider: AiProvider }).provider, b.alertUsd, b.reason, req.ip), 'Alert saved'); }));
adminRouter.get('/ai/chat', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await chat.chatOverview()); }));
adminRouter.get('/ai/chat/questions', validate({ query: questionsQuery }), asyncHandler(async (req: Request, res: Response) => { const r = await chat.chatQuestions(req.query as unknown as { shopId?: string; route?: string; cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));
adminRouter.put('/ai/chat', superOnly, validate({ body: z.object({ chat: chatSettingsSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { chat: ChatSettingsInput; reason: string }; sent(res, await chat.updateChat(adminOf(req), b.chat, b.reason, req.ip), 'Chat settings saved'); }));
adminRouter.put('/ai/prices', superOnly, validate({ body: z.object({ prices: pricesSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { prices: PricesInput; reason: string }; sent(res, await chat.updatePrices(adminOf(req), b.prices, b.reason, req.ip), 'Prices saved'); }));
adminRouter.get('/shops/:id/coins', validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await ai.shopCoins((req.params as { id: string }).id)); }));
adminRouter.post('/shops/:id/coins', moneyRole, validate({ params: idParams, body: z.object({ coins: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, 'Give or take at least 1 token'), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { coins: number; reason: string }; sent(res, await ai.grantCoins(adminOf(req), (req.params as { id: string }).id, b.coins, b.reason, req.ip), b.coins > 0 ? `${String(b.coins)} tokens added` : `${String(-b.coins)} tokens taken back`); }));

// D95: Razorpay keys and the invoice details — the admin sets them here, never the server's env; accounts may look.
const setParams = z.object({ set: z.enum(GATEWAY_SETS) }).strict();
const secret = (what: string) => z.string().trim().regex(/^[!-~]{8,200}$/, `${what}: 8 or more characters, no spaces`);
const keysBody = z.object({ keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]{8,32}$/, 'A Razorpay key ID looks like rzp_live_…'), keySecret: secret('Key secret').optional(), webhookSecret: secret('Webhook secret').optional(), reason }).strict();
const billingBody = z.object({ gstin: z.string().trim().toUpperCase().refine((v) => v === '' || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v), 'A GSTIN has 15 characters, like 19AABCM1234A1Z5'), state: z.enum(STATES.map((x) => x.name) as [string, ...string[]]), sac: z.string().trim().regex(/^\d{6}$/, 'SAC: 6 digits'), reason }).strict();
adminRouter.get('/gateway', moneyRole, asyncHandler(async (_req: Request, res: Response) => { fetched(res, await gw.gatewayOverview()); }));
adminRouter.put('/gateway/keys/:set', superOnly, validate({ params: setParams, body: keysBody }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as KeysInput & { reason: string }; sent(res, await gw.updateKeys(adminOf(req), (req.params as { set: GatewaySet }).set, { keyId: b.keyId, keySecret: b.keySecret, webhookSecret: b.webhookSecret }, b.reason, req.ip), 'Keys saved'); }));
adminRouter.delete('/gateway/keys/:set', superOnly, validate({ params: setParams, body: z.object({ reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await gw.removeKeys(adminOf(req), (req.params as { set: GatewaySet }).set, (req.body as { reason: string }).reason, req.ip), 'Keys removed'); }));
adminRouter.post('/gateway/keys/:set/test', superOnly, validate({ params: setParams }), asyncHandler(async (req: Request, res: Response) => { const r = await gw.testGatewayKeys((req.params as { set: GatewaySet }).set); sent(res, r, r.message); }));
adminRouter.put('/gateway/active', superOnly, validate({ body: z.object({ active: z.enum(GATEWAY_ACTIVE), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { active: GatewayActive; reason: string }; sent(res, await gw.switchActive(adminOf(req), b.active, b.reason, req.ip), 'Online payments switched'); }));
adminRouter.put('/gateway/billing', superOnly, validate({ body: billingBody }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as BillingInput & { reason: string }; sent(res, await gw.updateBilling(adminOf(req), { gstin: b.gstin, state: b.state, sac: b.sac }, b.reason, req.ip), 'Invoice details saved'); }));

// D80: referral program — the terms are super's; who referred a shop is support's (shops role).
adminRouter.get('/referrals', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.referrals()); }));
adminRouter.put('/referrals/settings', superOnly, validate({ body: z.object({ settings: referralSettingsSchema, reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { settings: ReferralSettings; reason: string }; sent(res, await svc.saveReferral(adminOf(req), b.settings, b.reason, req.ip), 'Referral settings saved'); }));
adminRouter.put('/shops/:id/referrer', shopsRole, validate({ params: idParams, body: z.object({ referrerShopId: objectId.nullable(), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { referrerShopId: string | null; reason: string }; await svc.setReferrer(adminOf(req), (req.params as { id: string }).id, b.referrerShopId, b.reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), b.referrerShopId ? 'Referrer saved' : 'Referrer removed'); }));

adminRouter.get('/category-requests', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await categories.adminList()); }));
adminRouter.post('/category-requests/:id', superOnly, validate({ params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(200).default('') }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { decision: 'approve' | 'reject'; reason: string }; const a = adminOf(req); const out = await categories.decide(new Types.ObjectId((req.params as { id: string }).id), { id: a.id, name: a.name }, b.decision, b.reason, 'console', req.ip); sent(res, out, b.decision === 'approve' ? `“${out.name}” added for every shop` : `“${out.name}” turned down`); }));

adminRouter.get('/team', superOnly, asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.team()); }));
adminRouter.post('/team', superOnly, validate({ body: z.object({ email, name: z.string().trim().min(2).max(80), role: z.enum(ADMIN_ROLES), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { email: string; name: string; role: (typeof ADMIN_ROLES)[number]; reason: string }; sent(res, await svc.invite(adminOf(req), b, b.reason, req.ip), `${b.name} added`); }));
adminRouter.patch('/team/:id', superOnly, validate({ params: idParams, body: z.object({ role: z.enum(ADMIN_ROLES).optional(), status: z.enum(['active', 'disabled']).optional(), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { role?: (typeof ADMIN_ROLES)[number]; status?: 'active' | 'disabled'; reason: string }; sent(res, await svc.setMember(adminOf(req), (req.params as { id: string }).id, { ...(b.role ? { role: b.role } : {}), ...(b.status ? { status: b.status } : {}) }, b.reason, req.ip), 'Saved'); }));

adminRouter.put('/shops/:id/prices', moneyRole, validate({ params: idParams, body: z.object({ prices: z.array(z.object({ code: z.string().min(2).max(20), price: z.number().int().min(100).max(10_000_000).nullable() }).strict()).min(1).max(6), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { prices: { code: string; price: number | null }[]; reason: string }; await svc.setShopPrices(adminOf(req), (req.params as { id: string }).id, b.prices, b.reason, req.ip); sent(res, await svc.shop((req.params as { id: string }).id), 'Price saved'); }));
adminRouter.get('/shops/:id/retention', validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.retentionOf((req.params as { id: string }).id)); }));
adminRouter.put('/shops/:id/retention', moneyRole, validate({ params: idParams, body: z.object({ tier: z.enum(['legal', 'y10']), legalHold: z.boolean(), legalHoldReason: z.string().trim().max(200), reason }).strict().refine((v) => !v.legalHold || v.legalHoldReason.length >= 3, { message: 'Name the case for a legal hold', path: ['legalHoldReason'] }) }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { tier: 'legal' | 'y10'; legalHold: boolean; legalHoldReason: string; reason: string }; sent(res, await svc.setRetention(adminOf(req), (req.params as { id: string }).id, b, req.ip), 'Data settings saved'); }));
adminRouter.get('/health', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.health()); }));
adminRouter.get('/perf', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await perfOverview()); }));
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

adminRouter.get('/brand', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await brand.brandInfo()); }));
adminRouter.put('/brand', superOnly, validate({ body: z.object({ image: z.string().max(900_000), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { image: string; reason: string }; sent(res, await brand.saveLogo(adminOf(req), b.image, b.reason, req.ip), 'Logo saved — it shows everywhere within 5 minutes'); }));
adminRouter.delete('/brand', superOnly, validate({ body: z.object({ reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await brand.resetLogo(adminOf(req), (req.body as { reason: string }).reason, req.ip), 'Back to the MedBox24 logo'); }));

// The marketing team's demo shop: made, refilled and signed in with a code only the super admin sets.
adminRouter.get('/demo', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await demo.demoInfo()); }));
adminRouter.post('/demo', superOnly, validate({ body: z.object({ reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await demo.createDemo(adminOf(req), (req.body as { reason: string }).reason, req.ip), 'Demo shop made — its data is being filled now'); }));
adminRouter.post('/demo/reset', shopsRole, validate({ body: z.object({ reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { sent(res, await demo.resetDemo(adminOf(req), (req.body as { reason: string }).reason, req.ip), 'Demo data is being made again'); }));
adminRouter.put('/demo/code', superOnly, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/, 'Six digits'), reason }).strict() }), asyncHandler(async (req: Request, res: Response) => { const b = req.body as { code: string; reason: string }; sent(res, await demo.setDemoCode(adminOf(req), b.code, b.reason, req.ip), 'Demo code saved — demo devices are signed out'); }));

adminRouter.get('/audit', validate({ query: z.object({ cursor: z.string().max(400).optional(), limit: LIMIT }).strict() }), asyncHandler(async (req: Request, res: Response) => { const r = await svc.auditLog(req.query as unknown as { cursor?: string; limit: number }); fetched(res, r.items, r.meta); }));

/** Public: the maintenance banner, support contacts and the trial, for the shop app and the public site. */
export const platformRouter = Router();
platformRouter.get('/', asyncHandler(async (_req: Request, res: Response) => { const p = await platform(); fetched(res, { maintenance: p.maintenance, supportEmail: p.supportEmail, supportPhone: p.supportPhone, trialDays: p.trialDays, trialMaxUsers: p.trialMaxUsers, graceDays: p.graceDays, legalName: p.legalName, address: p.address, grievanceOfficer: p.grievanceOfficer }); }));

/** Shop side (owner): see MedBox24's requests, approve / deny / stop. */
export const supportAccessRouter = Router();
supportAccessRouter.use(shopAuth);
supportAccessRouter.get('/', asyncHandler(async (req: Request, res: Response) => { fetched(res, await support.forShop(tenantOf(req))); }));
supportAccessRouter.post('/:id/:decision', validate({ params: z.object({ id: objectId, decision: z.enum(['approve', 'deny', 'revoke']) }).strict() }), asyncHandler(async (req: Request, res: Response) => { const p = req.params as { id: string; decision: 'approve' | 'deny' | 'revoke' }; sent(res, await support.decide(tenantOf(req), await actorOf(req), p.id, p.decision, req.ip), p.decision === 'approve' ? 'Access given' : p.decision === 'deny' ? 'Request denied' : 'Access stopped'); }));
