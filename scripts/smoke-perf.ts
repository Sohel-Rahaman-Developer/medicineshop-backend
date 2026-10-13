// v1.21.1 checks: Server-Timing on every API answer, per-route totals with ids folded, slow loads a browser reports,
// and the admin's Speed panel that reads them.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const item = { kind: 'page', path: '/sales', screen: '/sales', ms: 5400, server: null, db: null };

interface Perf {
  routes: { path: string; n: number; avg: number; queries: number }[];
  slow24h: { source: string; kind: string; path: string; n: number; avg: number; max: number }[];
  recent: { source: string; path: string; ms: number }[];
}

async function main() {
  const h = await startHarness();
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { PerfSampleModel, pathKey } = await import('../src/modules/perf/perf.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const step = () => Math.floor(Date.now() / 30_000);
  await AdminUserModel.create([{ email: 'root@perf.test', name: 'Root', role: 'super' }]);
  const admin = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('root@perf.test', '135790', 'admin');
  const r = data<{ secret?: string }>(await admin.post('/admin/auth/verify', { email: 'root@perf.test', otp: '135790' }));
  await admin.post('/admin/auth/totp', { code: totpAt(r.secret ?? '', step()) });
  const owner = await h.signIn('rohit@perf1.test');
  owner.shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  const ratna = data<{ id: string }>(await owner.post('/customers', { name: 'Ratna Sen', phone: '98300 12345' })).id;

  section('1. Server-Timing on every API answer');
  const cats = await owner.raw('GET', '/categories', undefined, { origin: 'http://localhost:3000' });
  const st = cats.headers.get('server-timing') ?? '';
  check('app and db times, with the query count', /app;dur=[\d.]+/.test(st) && /db;dur=[\d.]+;desc="[1-9]\d* queries"/.test(st), st);
  check('the shop app may read it (Timing-Allow-Origin)', cats.headers.get('timing-allow-origin') === 'http://localhost:3000', cats.headers.get('timing-allow-origin') ?? 'none');
  const other = h.client({ origin: 'https://evil.example' });
  check('another site may not', (await other.raw('GET', '/health', undefined, { origin: 'https://evil.example' })).headers.get('timing-allow-origin') === null);
  check('an error answer carries it too', ((await owner.get('/customers/000000000000000000000000')).headers.get('server-timing') ?? '').startsWith('app;dur='));

  section('2. Paths fold ids, numbers and tokens');
  check('a record id → :id', pathKey('/api/v1/customers/65f1a2b3c4d5e6f708192a3b/points-link?x=1') === '/customers/:id/points-link', pathKey('/api/v1/customers/65f1a2b3c4d5e6f708192a3b/points-link?x=1'));
  check('a number → :n, a token → :token', pathKey('/api/v1/public/points/Ab3dEfGh1jKlMn0pQrStUvWx') === '/public/points/:token' && pathKey('/api/v1/reports/2026') === '/reports/:n');

  section('3. A browser reports slow loads');
  const anon = h.client();
  check('not signed in → 401', (await anon.post('/perf', { items: [item] })).status === 401);
  check('a path with odd characters → 422', (await owner.post('/perf', { items: [{ ...item, path: '/sales?q=<script>' }] })).status === 422);
  check('more than 20 in one go → 422', (await owner.post('/perf', { items: Array.from({ length: 21 }, () => item) })).status === 422);
  check('an unknown field → 422', (await owner.post('/perf', { items: [{ ...item, name: 'Ratna' }] })).status === 422);
  const ok = await owner.post('/perf', { items: [item, { ...item, kind: 'api', path: 'GET /customers/:id', screen: '/customers/:id', ms: 3100, server: 2900, db: 2500 }] });
  check('kept', ok.status === 200 && (await PerfSampleModel.countDocuments({ source: 'browser' })) === 2, code(ok));
  check('kept for 7 days, then the database drops them', (await PerfSampleModel.collection.indexes()).some((i) => i.expireAfterSeconds === 7 * 24 * 60 * 60));
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) limited = (await owner.post('/perf', { items: [item] })).status === 429;
  check('more than 10 reports a minute from one person → 429', limited);

  section('4. The admin’s Speed panel');
  await owner.get(`/customers/${ratna}`);
  await owner.get(`/customers/${ratna}`);
  check('a shop user can’t read it → 401', (await owner.get('/admin/perf')).status === 401);
  const p = await admin.get('/admin/perf');
  const v = data<Perf>(p);
  const cust = v.routes.find((x) => x.path === 'GET /customers/:id');
  check('per-route totals, one row for every customer opened', p.status === 200 && (cust?.n ?? 0) >= 2 && (cust?.queries ?? 0) > 0, JSON.stringify(cust));
  check('health checks and the reports themselves are left out', !v.routes.some((x) => x.path.endsWith(' /health') || x.path.endsWith(' /perf')), v.routes.map((x) => x.path).join(', '));
  const page = v.slow24h.find((x) => x.source === 'browser' && x.kind === 'page' && x.path === '/sales');
  check('slow loads grouped by screen, with the average and the worst', (page?.n ?? 0) >= 2 && page?.avg === 5400 && page.max === 5400, JSON.stringify(page));
  check('the latest ones listed', v.recent.length > 0 && v.recent.every((x) => !JSON.stringify(x).includes('Ratna')));

  await h.close();
  finish();
}

main().catch(crash);
