// D113: every plan feature is refused by the API when the plan lacks it — each one has its probes here, so a feature
// with no backend lock (a screen locked only in the app) fails this suite. The law's reports and the daily work never lock.
import { basicOpens, seedBasic } from './lib/basic-plans';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${String(r.status)} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const refusedFor = (r: Res, f: string) => r.status === 403 && r.json.error?.code === 'PLAN_UPGRADE' && (r.json.error.details as { feature?: string } | undefined)?.feature === f;
const DAY = 86_400_000;

const shopBody = (name: string) => ({
  owner: { name: 'Gita Paul', phone: '98300 41123' },
  shop: { name, address: { line1: '2 Lake Road', city: 'Kolkata', state: 'West Bengal', pincode: '700029' }, phone: '033 2466 0101', drugLicenseNumber: 'WB/KOL/RLF20B/2022/0101', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-11',
  agree: true,
});

async function main() {
  const h = await startHarness();
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { FEATURES, REPORTS } = await import('../src/modules/subscription/features.js');
  // Written out, not read from the code: a change to the code must not move what this suite expects.
  const OPEN_REPORTS = ['gst-sales', 'gst-purchase', 'h1', 'x'];
  const { forgetPlanFeatures } = await import('../src/modules/subscription/plan-access.js');

  const owner = await h.signIn('gita@gates.test');
  owner.shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Lake Road Pharmacy'))).id;
  const ctx = async () => data<{ features: string[] }>(await owner.get('/shop/context'));
  const month = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7);
  const today = `${month}-01`;
  const range = `from=${today}&to=${today}`;

  /** Each feature's routes. A new feature without an entry here fails the completeness check below. */
  const PROBES: Record<string, ((c: Client) => Promise<Res>)[]> = {
    analytics: [(c) => c.get(`/reports/analytics?tab=sales&${range}`)],
    pnl: [(c) => c.get(`/reports/pnl?${range}`), (c) => c.get(`/reports/daybook?month=${month}`), (c) => c.get(`/reports/r/pnl?${range}`), (c) => c.get(`/reports/r/daybook?month=${month}`)],
    loyalty: [(c) => c.get('/loyalty/settings')],
    doctors: [(c) => c.post('/doctors', { name: 'Dr. Ray', specialization: 'Physician', registrationNumber: 'WBMC 1', phone: '98300 11111', clinic: '' })],
    orders: [(c) => c.get('/orders')],
    roles: [(c) => c.post('/roles', { name: 'Night shift', color: '#0ea5e9', permissions: { pos: ['view', 'create'] }, scopes: {} })],
    ask: [(c) => c.get('/ask/offer')],
    ai: [(c) => c.post('/pos/rx-read', {}), (c) => c.post('/pos/find-salt', {})],
    'bill-import': [(c) => c.post('/purchases/import/read', {}), (c) => c.post('/purchases/import/preview', {}), (c) => c.post('/purchases/import', {}), (c) => c.post('/purchases/import/ai', {})],
    clinic: [(c) => c.get('/clinic/day')],
    brief: [(c) => c.get('/brief')],
    refills: [(c) => c.get('/refills')],
    labels: [(c) => c.get('/labels/items')],
    tally: [(c) => c.get(`/reports/tally?month=${month}`), (c) => c.get(`/reports/tally/file?month=${month}&kind=vouchers`)],
    registers: [(c) => c.get(`/reports/registers/sales?${range}`), (c) => c.get(`/reports/registers/stock`), (c) => c.get(`/reports/registers/purchases/export?${range}&format=xlsx`)],
    ...Object.fromEntries(REPORTS.map((k) => [`report:${k}`, [(c: Client) => c.get(`/reports/r/${k}?${range}&month=${month}`), (c: Client) => c.get(`/reports/r/${k}/export?${range}&month=${month}&format=xlsx`)]])),
  };

  section('1. Every feature has its probes');
  const missing = FEATURES.filter((f) => !(f in PROBES));
  check('each feature in the catalog has backend routes to probe', missing.length === 0, missing.join());
  const extra = Object.keys(PROBES).filter((k) => !(FEATURES as readonly string[]).includes(k));
  check('…and nothing here that the catalog dropped', extra.length === 0, extra.join());

  section('2. Free trial: the whole app');
  const trial = await ctx();
  check('a trial shop has every feature, the reports one by one too', FEATURES.every((f) => trial.features.includes(f)), String(trial.features.length));
  const open: string[] = [];
  for (const [f, probes] of Object.entries(PROBES)) for (const p of probes) if (refusedFor(await p(owner), f)) open.push(f);
  check('…and no route refuses it for the plan', open.length === 0, open.join());

  section('3. A plan with nothing ticked: each feature refused, by name');
  await seedBasic();
  await basicOpens([]);
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'basic-monthly', status: 'active', endDate: new Date(Date.now() + 30 * DAY) } });
  forgetPlanFeatures();
  check('context: no features', (await ctx()).features.length === 0);
  const leaks: string[] = [];
  for (const [f, probes] of Object.entries(PROBES)) for (const [i, p] of probes.entries()) { const r = await p(owner); if (!refusedFor(r, f)) leaks.push(`${f}#${String(i)} ${code(r)}`); }
  check('every probe answers 403 PLAN_UPGRADE naming its own feature', leaks.length === 0, leaks.join(' | '));
  const sr = await owner.get(`/reports/r/sales-register?${range}`);
  check('a locked report names itself: "Sales register is in the Pro plan"', /^Sales register is in the Pro plan/.test(sr.json.error?.message ?? ''), code(sr));

  section('4. The daily work and the law’s reports never lock');
  const never = {
    gst: await owner.get(`/reports/gst?month=${month}`),
    ...Object.fromEntries(await Promise.all(OPEN_REPORTS.map(async (k) => [k, await owner.get(`/reports/r/${k}?${range}&month=${month}`)] as const))),
    gstExcel: await owner.get(`/reports/r/gst-sales/export?${range}&format=xlsx`),
    doctorsList: await owner.get('/doctors'),
    customers: await owner.get('/customers'),
    expenses: await owner.get('/expenses'),
    products: await owner.get('/products'),
    sales: await owner.get('/sales'),
    roles: await owner.get('/roles'),
  };
  const shut = Object.entries(never).filter(([, r]) => r.status !== 200).map(([k, r]) => `${k} ${code(r)}`);
  check('GST, H1, X, the doctor list for a bill, customers, expenses, stock, sales: 200', shut.length === 0, shut.join(' | '));
  const catalog = data<{ key: string; locked: boolean }[]>(await owner.get('/reports/catalog'));
  check('the report list stays open and marks each report: GST / H1 / X open, the rest locked', catalog.length === 25 && catalog.filter((r) => !r.locked).map((r) => r.key).sort().join() === [...OPEN_REPORTS].sort().join(), JSON.stringify(catalog.filter((r) => !r.locked)));

  section('5. One report ticked opens that report only');
  await basicOpens(['report:expiry']);
  check('Expiry answers', (await owner.get(`/reports/r/expiry?${range}`)).status === 200);
  check('…Expired stays locked', refusedFor(await owner.get(`/reports/r/expired?${range}`), 'report:expired'));
  check('…and the list unlocks just Expiry', data<{ key: string; locked: boolean }[]>(await owner.get('/reports/catalog')).filter((r) => !r.locked).length === OPEN_REPORTS.length + 1);

  section('5b. A bill read by AI needs both: bill import and AI');
  await basicOpens(['ai']);
  check('AI on, bill import off: reading a bill with AI → refused for bill import', refusedFor(await owner.post('/purchases/import/ai', {}), 'bill-import'));
  check('…a prescription photo still goes to the AI (422 for the empty photo, not the plan)', (await owner.post('/pos/rx-read', {})).status === 422);
  await basicOpens(['bill-import']);
  check('bill import on, AI off: a PDF or Word bill reads (422 for the empty body), AI reading → refused for AI', (await owner.post('/purchases/import/read', {})).status === 422 && refusedFor(await owner.post('/purchases/import/ai', {}), 'ai'));
  check('typing a purchase by hand is never locked: the purchase list answers', (await owner.get('/purchases')).status === 200);

  section('6. The catalog the admin and the website read');
  const cat = data<{ always: string[]; modules: { key: string; name: string }[]; reports: { key: string; name: string; group: string }[]; openReports: string[] }>(await h.client().get('/plans/features'));
  check('GET /plans/features: every feature once, with names; reports carry the report centre’s names', [...cat.modules, ...cat.reports].map((x) => x.key).join() === FEATURES.join() && cat.reports.find((r) => r.key === 'report:sales-register')?.name === 'Sales register' && cat.always.length > 0 && cat.openReports.includes('GST sales summary (HSN-wise)'), JSON.stringify(cat).slice(0, 300));

  await h.close();
  finish();
}

main().catch(crash);
