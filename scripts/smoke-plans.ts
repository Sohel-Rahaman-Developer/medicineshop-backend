// D87 checks: Basic and Pro — each plan opens its own modules, the server refuses the rest, trial and the demo see
// everything, old plans become Pro, and the admin's ticks take effect at once.
import { startFakeClaude } from './lib/fake-claude';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const upgrade = (r: Res) => r.status === 403 && r.json.error?.code === 'PLAN_UPGRADE';

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const DAY = 86_400_000;
const ALL = ['analytics', 'reports', 'pnl', 'loyalty', 'doctors', 'orders', 'roles', 'ask', 'ai', 'clinic'];

interface Plan { code: string; name: string; tier: string; features: string[]; isActive: boolean; maxUsers: number }

async function main() {
  const fake = await startFakeClaude();
  process.env.AI_BASE_URL = fake.url;
  const h = await startHarness();
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { PlanModel } = await import('../src/modules/subscription/billing.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { forgetTiers } = await import('../src/modules/subscription/subscription.service.js');
  const { forgetPlanFeatures } = await import('../src/modules/subscription/plan-access.js');
  const { totpAt } = await import('../src/utils/totp.js');

  section('1. A new platform: Basic and Pro, monthly and yearly');
  const plans = data<Plan[]>(await h.client().get('/plans'));
  check('4 plans on sale: Basic Monthly, Basic Yearly, Pro Monthly, Pro Yearly', plans.map((p) => p.name).join() === 'Basic Monthly,Basic Yearly,Pro Monthly,Pro Yearly', JSON.stringify(plans.map((p) => p.name)));
  check('Basic opens no extra module, 2 users; Pro opens all 10', plans.filter((p) => p.tier === 'basic').every((p) => p.features.length === 0 && p.maxUsers === 2) && plans.filter((p) => p.tier === 'pro').every((p) => p.features.join() === ALL.join()));

  const owner = await h.signIn('rohit@plans1.test');
  owner.shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  const ctx = async () => data<{ features: string[]; subscription: { planCode: string } }>(await owner.get('/shop/context'));
  check('a trial shop sees every module', (await ctx()).features.join() === ALL.join());
  check('…and its reports, P&L, analytics, loyalty, orders, Ask all answer', (await owner.get('/reports/catalog')).status === 200 && (await owner.get('/loyalty/settings')).status === 200 && (await owner.get('/orders')).status === 200 && (await owner.get('/ask/offer')).status === 200);

  section('2. Basic: the daily work only — the server refuses the rest');
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'basic-monthly', status: 'active', endDate: new Date(Date.now() + 30 * DAY) } });
  forgetPlanFeatures();
  check('context: Basic, no extra modules', (await ctx()).features.length === 0 && (await ctx()).subscription.planCode === 'basic-monthly');
  const month = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7);
  const today = `${month}-01`;
  const refused = {
    analytics: await owner.get(`/reports/analytics?tab=sales&from=${today}&to=${today}`),
    pnl: await owner.get(`/reports/pnl?from=${today}&to=${today}`),
    daybook: await owner.get(`/reports/daybook?month=${month}`),
    catalog: await owner.get('/reports/catalog'),
    report: await owner.get(`/reports/r/sales-register?from=${today}&to=${today}`),
    loyalty: await owner.get('/loyalty/settings'),
    orders: await owner.get('/orders'),
    ask: await owner.get('/ask/offer'),
    role: await owner.post('/roles', { name: 'Night shift', color: '#0ea5e9', permissions: { pos: ['view', 'create'] }, scopes: {} }),
    aiBill: await owner.post('/purchases/import/ai', {}),
    clinic: await owner.get('/clinic/day'),
  };
  for (const [k, r] of Object.entries(refused)) check(`Basic: ${k} → 403 PLAN_UPGRADE`, upgrade(r), code(r));
  check('…the message names the module and Pro', /Analytics is in the Pro plan/.test(refused.analytics.json.error?.message ?? ''), code(refused.analytics));
  const open = {
    gst: await owner.get(`/reports/gst?month=${month}`),
    gstExcel: await owner.get(`/reports/r/gst-sales?from=${today}&to=${today}`),
    roles: await owner.get('/roles'),
    doctors: await owner.get('/doctors'),
    customers: await owner.get('/customers'),
    expenses: await owner.get('/expenses'),
    dashboard: await owner.get(`/dashboard?from=${today}&to=${today}`),
  };
  for (const [k, r] of Object.entries(open)) check(`Basic: ${k} still works`, r.status === 200, code(r));
  const pos = data<{ loyalty: { enabled: boolean } }>(await owner.get('/pos/settings'));
  check('Basic: the counter earns and redeems no points', !pos.loyalty.enabled);

  section('3. The admin decides what each plan opens — at once');
  await AdminUserModel.create([{ email: 'root@medshop.test', name: 'Root', role: 'super' }, { email: 'ops@medshop.test', name: 'Ops', role: 'support' }]);
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const r = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' }));
    await c.post('/admin/auth/totp', { code: totpAt(r.secret ?? '', Math.floor(Date.now() / 30_000)) });
    return c;
  };
  const root = await login('root@medshop.test');
  const ops = await login('ops@medshop.test');
  const all = data<Plan[]>(await root.get('/admin/plans'));
  check('admin lists every plan with its tier and modules', all.length === 4 && all.every((p) => p.tier && Array.isArray(p.features)));
  const body = (basic: string[]) => ({ plans: all.map((p) => ({ code: p.code, name: p.name, price: 79_900, durationDays: p.code.includes('yearly') ? 365 : 30, maxUsers: p.maxUsers, isActive: true, tier: p.tier, features: p.tier === 'basic' ? basic : p.features })), reason: 'Ask is free for every shop' });
  check('support cannot change plans → 403', (await ops.put('/admin/plans', body(['ask']))).status === 403);
  check('an unknown module → 422', (await root.put('/admin/plans', body(['ask', 'teleport']))).status === 422);
  const saved = await root.put('/admin/plans', body(['ask']));
  check('super: Basic now opens Ask your shop', saved.status === 200 && data<Plan[]>(saved).find((p) => p.code === 'basic-monthly')?.features.join() === 'ask', code(saved));
  check('…the Basic shop can ask at once (no waiting for a cache)', (await owner.get('/ask/offer')).status === 200 && (await ctx()).features.join() === 'ask');
  await root.put('/admin/ai/key', { apiKey: fake.key, reason: 'new key from Anthropic console' });
  await root.put('/admin/ai/chat', { chat: { enabled: true, model: 'claude-haiku-4-5-20251001', coinsPerQuestion: 1, freeQuestions: 2, capIn: 8000, capOut: 500, perShopDay: 100, budgetUsd: 50 }, reason: 'launch the shop chat' });
  await owner.put('/ask/ai', { on: true });
  const stop = data<{ ai: { stop: string | null } }>(await owner.get('/ask/offer')).ai.stop;
  const yes = data<{ route: string; text: string }>(await owner.post('/ask', { text: 'Dolo kis kaam aati hai', confirm: true }));
  check('…but its AI answers stay Pro: AI on for the platform and the shop, still “plan”, Claude never asked', stop === 'plan' && yes.route === 'blocked' && yes.text.startsWith('AI jawab Pro plan mein hain') && fake.seen.length === 0, `${String(stop)} ${JSON.stringify(yes)}`);
  const offSale = await root.put('/admin/plans', { ...body(['ask']), plans: body(['ask']).plans.map((p) => (p.code === 'basic-yearly' ? { ...p, isActive: false } : p)) });
  check('a plan taken off sale leaves the shop list but stays in the admin list', offSale.status === 200 && !data<Plan[]>(await h.client().get('/plans')).some((p) => p.code === 'basic-yearly') && data<Plan[]>(await root.get('/admin/plans')).some((p) => p.code === 'basic-yearly' && !p.isActive));

  section('4. Pro and the demo open everything');
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'monthly' } });
  forgetPlanFeatures();
  check('Pro Monthly: all 10 modules, reports answer', (await ctx()).features.join() === ALL.join() && (await owner.get('/reports/catalog')).status === 200);
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'gone-plan' } });
  forgetPlanFeatures();
  check('a plan code the admin deleted keeps everything (a paying shop never loses work)', (await ctx()).features.length === ALL.length);

  section('5. Before D87: Monthly / Yearly become Pro, Basic waits off sale');
  await PlanModel.deleteMany({ tier: 'basic' });
  await PlanModel.updateMany({}, { $unset: { tier: 1, features: 1 } });
  await PlanModel.updateOne({ code: 'monthly' }, { $set: { name: 'Monthly' } });
  await PlanModel.updateOne({ code: 'yearly' }, { $set: { name: 'Yearly' } });
  forgetTiers();
  const after = data<Plan[]>(await h.client().get('/plans'));
  check('shops see only Pro Monthly and Pro Yearly — Basic is not on sale until priced', after.map((p) => p.name).join() === 'Pro Monthly,Pro Yearly' && after.every((p) => p.tier === 'pro' && p.features.length === ALL.length), JSON.stringify(after.map((p) => p.name)));
  const listed = data<Plan[]>(await root.get('/admin/plans'));
  check('the admin sees Basic Monthly and Basic Yearly, off sale, no extra modules', listed.filter((p) => p.tier === 'basic' && !p.isActive && p.features.length === 0).length === 2, JSON.stringify(listed.map((p) => `${p.name}:${String(p.isActive)}`)));
  forgetTiers();
  await h.client().get('/plans');
  check('running it again changes nothing', (await PlanModel.countDocuments({})) === 4);

  section('6. A module added later (D90 clinic) joins Pro by itself, never Basic');
  const d87 = ALL.filter((f) => f !== 'clinic');
  await PlanModel.updateMany({ tier: 'pro' }, { $set: { features: d87 }, $unset: { knows: 1 } });
  await PlanModel.updateMany({ tier: 'basic' }, { $set: { features: ['loyalty'] }, $unset: { knows: 1 } });
  forgetTiers();
  forgetPlanFeatures();
  const grown = data<Plan[]>(await root.get('/admin/plans'));
  check('Pro plans now open the doctor chamber too; Basic keeps exactly what the admin ticked', grown.filter((p) => p.tier === 'pro').every((p) => p.features.includes('clinic') && p.features.length === ALL.length) && grown.filter((p) => p.tier === 'basic').every((p) => p.features.join() === 'loyalty'), JSON.stringify(grown.map((p) => `${p.code}:${p.features.join('+')}`)));
  await PlanModel.updateMany({ tier: 'pro' }, { $pull: { features: 'clinic' } });
  forgetTiers();
  await h.client().get('/plans');
  check('once known, the admin can take it off a Pro plan and it stays off', (await PlanModel.find({ tier: 'pro' }).lean()).every((p) => !(p.features ?? []).includes('clinic')));
  await PlanModel.deleteMany({});
  forgetTiers();
  forgetPlanFeatures();
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'basic-monthly' } });
  check('a fresh database: a Basic shop is Basic before anyone opens the plan list', (await ctx()).features.length === 0 && upgrade(await owner.get('/reports/catalog')));

  await fake.close();
  await h.close();
  finish();
}

main().catch(crash);
