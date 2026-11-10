// D87 + D113 checks: two packages, Basic and Pro — each opens its own features and users, the plans only carry the price
// (before GST, 18% added); the server refuses the rest; trial and the demo see everything; old plan lists are brought
// forward once; the admin's ticks and prices take effect at once.
import { startFakeClaude } from './lib/fake-claude';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const upgrade = (r: Res) => r.status === 403 && r.json.error?.code === 'PLAN_UPGRADE';

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-11',
  agree: true,
});
const DAY = 86_400_000;
/** D113: the catalog the server keeps — modules, then each report. */
let ALL: string[] = [];
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
// Written out, not read from the code: the Basic the user asked for (10 Nov) — AI reading and the everyday reports.
const BASIC = ['ai', 'report:sales-register', 'report:sales-summary', 'report:stock-on-hand', 'report:expiry', 'report:expired', 'report:purchase-register', 'report:supplier-outstanding', 'report:customer-outstanding', 'report:expenses'];

interface Plan { code: string; name: string; tier: string; features: string[]; isActive: boolean; maxUsers: number; price: number; basePrice: number; basePerMonth: number; perMonth: number; durationDays: number }
interface Pack { tier: string; name: string; features: string[]; maxUsers: number }

async function main() {
  const fake = await startFakeClaude();
  process.env.AI_BASE_URL = fake.url;
  const h = await startHarness();
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { PackageModel, PlanModel } = await import('../src/modules/subscription/billing.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { forgetTiers } = await import('../src/modules/subscription/subscription.service.js');
  const { forgetPlanFeatures } = await import('../src/modules/subscription/plan-access.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { FEATURES } = await import('../src/modules/subscription/features.js');
  ALL = [...FEATURES];

  section('1. A new platform: Basic and Pro, monthly and yearly, GST added on top (D113, 10 Nov 2026)');
  const fresh = data<Plan[]>(await h.client().get('/plans'));
  // ₹299 × 1.18 = ₹352.82; ₹2,388 × 1.18 = ₹2,817.84; ₹399 × 1.18 = ₹470.82; ₹3,588 × 1.18 = ₹4,233.84.
  check('4 plans on sale, Basic first: before GST ₹299 / ₹2,388 / ₹399 / ₹3,588 → with GST ₹352.82 / ₹2,817.84 / ₹470.82 / ₹4,233.84', fresh.map((p) => `${p.code} ${String(p.basePrice)} ${String(p.price)}`).join() === 'basic-monthly 29900 35282,basic-yearly 238800 281784,monthly 39900 47082,yearly 358800 423384', JSON.stringify(fresh.map((p) => [p.code, p.basePrice, p.price])));
  check('a month before GST: Basic ₹299 monthly, ₹199 billed yearly (₹2,388 ÷ 12); Pro ₹399, ₹299 billed yearly (₹3,588 ÷ 12)', fresh.map((p) => p.basePerMonth).join() === '29900,19900,39900,29900', JSON.stringify(fresh.map((p) => p.basePerMonth)));
  check('Basic opens AI reading and 9 everyday reports, 3 users; Pro opens every feature, 10 users', fresh.filter((p) => p.tier === 'basic').every((p) => same(p.features, BASIC) && p.maxUsers === 3) && fresh.filter((p) => p.tier === 'pro').every((p) => same(p.features, ALL) && p.maxUsers === 10));
  const pub = data<{ packages: Pack[]; plans: Plan[] }>(await h.client().get('/plans/packages'));
  check('GET /plans/packages: Basic then Pro, each once, with the plans on sale', pub.packages.map((p) => `${p.tier}:${p.name}:${String(p.maxUsers)}`).join() === 'basic:Basic:3,pro:Pro:10' && pub.plans.length === 4);

  const owner = await h.signIn('rohit@plans1.test');
  owner.shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  const ctx = async () => data<{ features: string[]; subscription: { planCode: string; maxUsers: number } }>(await owner.get('/shop/context'));
  check('a trial shop sees every feature', same((await ctx()).features, ALL));
  check('…and its reports, P&L, analytics, loyalty, orders, Ask all answer', (await owner.get('/reports/catalog')).status === 200 && (await owner.get('/loyalty/settings')).status === 200 && (await owner.get('/orders')).status === 200 && (await owner.get('/ask/offer')).status === 200);

  section('2. Basic: the daily work, AI reading and its reports — the server refuses the rest');
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'basic-monthly', status: 'active', maxUsers: 3, endDate: new Date(Date.now() + 30 * DAY) } });
  forgetPlanFeatures();
  const b = await ctx();
  check('context: Basic, exactly its features, 3 users', same(b.features, BASIC) && b.subscription.planCode === 'basic-monthly' && b.subscription.maxUsers === 3, JSON.stringify(b));
  const month = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7);
  const today = `${month}-01`;
  const refused = {
    analytics: await owner.get(`/reports/analytics?tab=sales&from=${today}&to=${today}`),
    pnl: await owner.get(`/reports/pnl?from=${today}&to=${today}`),
    daybook: await owner.get(`/reports/daybook?month=${month}`),
    productSales: await owner.get(`/reports/r/product-sales?from=${today}&to=${today}`),
    registers: await owner.get(`/reports/registers/sales?from=${today}&to=${today}`),
    loyalty: await owner.get('/loyalty/settings'),
    orders: await owner.get('/orders'),
    ask: await owner.get('/ask/offer'),
    role: await owner.post('/roles', { name: 'Night shift', color: '#0ea5e9', permissions: { pos: ['view', 'create'] }, scopes: {} }),
    billFile: await owner.post('/purchases/import/read', {}),
    clinic: await owner.get('/clinic/day'),
    brief: await owner.get('/brief'),
    refills: await owner.get('/refills'),
    labels: await owner.get('/labels/items'),
    tally: await owner.get(`/reports/tally?month=${month}`),
  };
  for (const [k, r] of Object.entries(refused)) check(`Basic: ${k} → 403 PLAN_UPGRADE`, upgrade(r), code(r));
  check('…the message names the module and Pro', /Analytics is in the Pro plan/.test(refused.analytics.json.error?.message ?? ''), code(refused.analytics));
  const open = {
    salesRegister: await owner.get(`/reports/r/sales-register?from=${today}&to=${today}`),
    expiry: await owner.get(`/reports/r/expiry?from=${today}&to=${today}`),
    gst: await owner.get(`/reports/gst?month=${month}`),
    gstExcel: await owner.get(`/reports/r/gst-sales?from=${today}&to=${today}`),
    roles: await owner.get('/roles'),
    doctors: await owner.get('/doctors'),
    customers: await owner.get('/customers'),
    expenses: await owner.get('/expenses'),
    dashboard: await owner.get(`/dashboard?from=${today}&to=${today}`),
  };
  for (const [k, r] of Object.entries(open)) check(`Basic: ${k} answers`, r.status === 200, code(r));
  check('Basic: a prescription goes to the AI reader (422 for the empty photo, not the plan)', (await owner.post('/pos/rx-read', {})).status === 422);
  const pos = data<{ loyalty: { enabled: boolean } }>(await owner.get('/pos/settings'));
  check('Basic: the counter earns and redeems no points', !pos.loyalty.enabled);

  section('3. The admin sets each package and each price — at once');
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
  const list = data<{ packages: Pack[]; plans: Plan[] }>(await root.get('/admin/packages'));
  check('admin lists both packages and every plan', list.packages.length === 2 && list.plans.length === 4);
  const body = (basic: string[], over: Partial<Record<string, Partial<Plan>>> = {}) => ({
    packages: list.packages.map((p) => ({ tier: p.tier, name: p.name, maxUsers: p.maxUsers, features: p.tier === 'basic' ? basic : p.features })),
    plans: list.plans.map((p) => ({ code: p.code, name: p.name, tier: p.tier, basePrice: p.basePrice, durationDays: p.durationDays, isActive: p.isActive, ...over[p.code] })),
    reason: 'Ask is free for every shop',
  });
  check('support cannot change packages → 403', (await ops.put('/admin/packages', body(['ask']))).status === 403);
  check('an unknown feature → 422', (await root.put('/admin/packages', body(['ask', 'teleport']))).status === 422);
  check('a price with paise before GST → 422 (whole rupees, so 18% is exact)', (await root.put('/admin/packages', body(['ask'], { 'basic-monthly': { basePrice: 29_950 } }))).status === 422);
  check('Basic twice, no Pro → 422', (await root.put('/admin/packages', { ...body(['ask']), packages: body(['ask']).packages.map((p) => ({ ...p, tier: 'basic' })) })).status === 422);
  // Ask ticked, AI reading unticked: the chat opens, its AI answers do not.
  const ASK = ['ask', ...BASIC.filter((f) => f !== 'ai')];
  const saved = await root.put('/admin/packages', body(ASK, { 'basic-monthly': { basePrice: 24_900 } }));
  const after = data<{ packages: Pack[]; plans: Plan[] }>(saved);
  // ₹249 × 1.18 = ₹293.82.
  check('super: Basic now opens Ask, AI reading off; Basic Monthly ₹249 before GST → ₹293.82', saved.status === 200 && after.packages.find((p) => p.tier === 'basic')?.features.includes('ask') === true && after.plans.find((p) => p.code === 'basic-monthly')?.price === 29_382, code(saved));
  check('…the Basic shop can ask at once (no waiting for a cache), and the website shows ₹293.82', (await owner.get('/ask/offer')).status === 200 && (await ctx()).features.includes('ask') && data<Plan[]>(await h.client().get('/plans')).find((p) => p.code === 'basic-monthly')?.price === 29_382);
  await root.put('/admin/ai/key', { apiKey: fake.key, reason: 'new key from Anthropic console' });
  await root.put('/admin/ai/chat', { chat: { enabled: true, model: 'claude-haiku-4-5-20251001', coinsPerQuestion: 1, capIn: 8000, capOut: 500, perShopDay: 100, budgetUsd: 50 }, reason: 'launch the shop chat' });
  await owner.put('/ask/ai', { on: true });
  const stop = data<{ ai: { stop: string | null } }>(await owner.get('/ask/offer')).ai.stop;
  const yes = data<{ route: string; text: string }>(await owner.post('/ask', { text: 'Dolo kis kaam aati hai', confirm: true }));
  check('…but with AI reading unticked its AI answers stay locked: AI on for the platform and the shop, still “plan”, Claude never asked', stop === 'plan' && yes.route === 'blocked' && yes.text.startsWith('AI jawab Pro plan mein hain') && fake.seen.length === 0, `${String(stop)} ${JSON.stringify(yes)}`);
  const offSale = await root.put('/admin/packages', body(ASK, { 'basic-yearly': { isActive: false } }));
  check('a plan taken off sale leaves the shop list but stays in the admin list', offSale.status === 200 && !data<Plan[]>(await h.client().get('/plans')).some((p) => p.code === 'basic-yearly') && data<{ plans: Plan[] }>(await root.get('/admin/packages')).plans.some((p) => p.code === 'basic-yearly' && !p.isActive));
  const users = await root.put('/admin/packages', { ...body(ASK), packages: body(ASK).packages.map((p) => (p.tier === 'basic' ? { ...p, maxUsers: 4 } : p)) });
  check('Basic users 3 → 4: the shop can add a 4th at once', users.status === 200 && (await ctx()).subscription.maxUsers === 4, code(users));
  await root.put('/admin/packages', { ...body(ASK), packages: body(ASK).packages.map((p) => (p.tier === 'basic' ? { ...p, maxUsers: 2 } : p)) });
  check('…down to 2: the shop keeps the 3 users its plan was paid with, till it pays again', (await ctx()).subscription.maxUsers === 3, String((await ctx()).subscription.maxUsers));

  section('4. Pro and the demo open everything');
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'monthly' } });
  forgetPlanFeatures();
  check('Pro Monthly: every feature, reports answer', same((await ctx()).features, ALL) && (await owner.get(`/reports/r/product-sales?from=${today}&to=${today}`)).status === 200);
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'gone-plan' } });
  forgetPlanFeatures();
  check('a plan code the admin deleted keeps everything (a paying shop never loses work)', (await ctx()).features.length === ALL.length);

  section('5. Before D87: Monthly / Yearly with no tier become Pro');
  await PackageModel.deleteMany({});
  await PlanModel.deleteMany({ tier: 'basic' });
  await PlanModel.updateMany({}, { $unset: { tier: 1, features: 1, knows: 1, basePrice: 1 } });
  await PlanModel.updateOne({ code: 'monthly' }, { $set: { name: 'Monthly', price: 49_900, maxUsers: 5 } });
  await PlanModel.updateOne({ code: 'yearly' }, { $set: { name: 'Yearly', price: 360_000, maxUsers: 15 } });
  await PlanModel.create({ code: 'two-year', name: 'Two years', price: 699_900, durationDays: 730, maxUsers: 10, sortOrder: 5, isActive: true });
  forgetTiers();
  forgetPlanFeatures();
  const moved = data<{ plans: Plan[] }>(await root.get('/admin/packages')).plans;
  check('the old plans become Pro — and D113 then brings in Basic and the 10 Nov prices', same(moved.map((p) => `${p.code}:${p.tier}`), ['basic-monthly:basic', 'basic-yearly:basic', 'monthly:pro', 'yearly:pro', 'two-year:pro']), JSON.stringify(moved.map((p) => `${p.code}:${p.tier}`)));
  check('Pro Monthly ₹499 → ₹470.82, Pro Yearly ₹3,600 → ₹4,233.84 (list prices of 10 Nov)', moved.find((p) => p.code === 'monthly')?.price === 47_082 && moved.find((p) => p.code === 'yearly')?.price === 423_384);
  // ₹6,999 ÷ 1.18 = ₹5,931.36 → ₹5,931 before GST → ₹6,998.58 with it.
  check('a plan the admin made keeps its price, its base rounded to the rupee: ₹6,999 → ₹5,931 + GST = ₹6,998.58', moved.find((p) => p.code === 'two-year')?.basePrice === 593_100 && moved.find((p) => p.code === 'two-year')?.price === 699_858, JSON.stringify(moved.find((p) => p.code === 'two-year')));
  const packs = await PackageModel.find({}).sort({ _id: 1 }).lean();
  check('packages made once: Pro opens everything with the most users any Pro plan had (15); Basic the 10 Nov list, 3 users', packs.length === 2 && same(packs[1]?.features ?? [], ALL) && packs[1]?.maxUsers === 15 && same(packs[0]?.features ?? [], BASIC) && packs[0]?.maxUsers === 3, JSON.stringify(packs.map((p) => [p._id, p.features.length, p.maxUsers])));
  forgetTiers();
  await h.client().get('/plans');
  check('running it again changes nothing', (await PlanModel.countDocuments({})) === 5 && (await PackageModel.countDocuments({})) === 2);

  section('6. Before D113: what the Pro plans opened becomes the Pro package; a feature added later joins Pro by itself, never Basic');
  const d87 = ['analytics', 'reports', 'pnl', 'loyalty', 'doctors', 'orders', 'roles', 'ask', 'ai', 'labels', 'tally'];
  await PackageModel.deleteMany({});
  await PlanModel.updateMany({ tier: 'pro' }, { $set: { features: d87 }, $unset: { knows: 1 } });
  await PlanModel.updateMany({ tier: 'basic' }, { $set: { features: ['loyalty', 'reports'] }, $unset: { knows: 1 } });
  forgetTiers();
  forgetPlanFeatures();
  await h.client().get('/plans');
  const grown2 = await PackageModel.find({}).sort({ _id: 1 }).lean();
  check('Pro: the old "reports" tick became the registers and every report, and the clinic, bill files, brief… joined', same(grown2[1]?.features ?? [], ALL), JSON.stringify(grown2.map((p) => [p._id, p.features.length])));
  check('Basic: the 10 Nov list (it was never on sale before)', same(grown2[0]?.features ?? [], BASIC));
  await PackageModel.updateOne({ _id: 'pro' }, { $pull: { features: 'clinic', knows: 'clinic' } });
  await PackageModel.updateOne({ _id: 'basic' }, { $pull: { knows: 'clinic' } });
  forgetTiers();
  await h.client().get('/plans');
  const later = await PackageModel.find({}).sort({ _id: 1 }).lean();
  check('a feature the packages had not seen (clinic) opens on Pro by itself, never on Basic', later[1]?.features.includes('clinic') === true && later[0]?.features.includes('clinic') === false);
  await PackageModel.updateOne({ _id: 'pro' }, { $pull: { features: 'clinic' } });
  forgetTiers();
  await h.client().get('/plans');
  check('once known, the admin can take it off Pro and it stays off', !(await PackageModel.findById('pro').lean())?.features.includes('clinic'));
  await PlanModel.deleteMany({});
  await PackageModel.deleteMany({});
  forgetTiers();
  forgetPlanFeatures();
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'monthly' } });
  check('a fresh database: the list prices are there before anyone opens the plan list', (await ctx()).features.length === ALL.length && (await PlanModel.find({}).sort({ sortOrder: 1 }).lean()).map((p) => p.price).join() === '35282,281784,47082,423384');

  await fake.close();
  await h.close();
  finish();
}

main().catch(crash);
