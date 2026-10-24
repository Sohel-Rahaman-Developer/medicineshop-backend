// VAPT checks beyond smoke-security: query and body tricks, limits that open again by themselves, and what load
// balancing needs — a second API worker on the same database sees the same sessions, limits and import progress.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Client, check, crash, finish, section, startHarness, type Res } from './lib/harness';

process.env.RATE_API_PER_USER_PER_MIN = '60';
process.env.RATE_FILES_PER_USER_PER_MIN = '3';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${String(r.status)} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const shop = (name: string) => ({ name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' });
const signup = (name: string) => ({ owner: { name: 'Rohit Agarwal', phone: '98300 41122' }, shop: shop(name), termsVersion: '2026-10', agree: true });
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const h = await startHarness();
  const { createApp } = await import('../src/app.js');
  const { SharedStore, RateHitModel } = await import('../src/core/rate-store.js');
  const { leader } = await import('../src/modules/notifications/jobs.js');
  const { PerfWorkerModel, perfOverview } = await import('../src/modules/perf/perf.js');

  // A second API worker on the same database, as PM2 cluster mode runs it.
  const second: Server = createApp().listen(0);
  await new Promise<void>((done) => second.once('listening', () => { done(); }));
  const addr = second.address();
  const base2 = `http://127.0.0.1:${String(typeof addr === 'object' && addr ? addr.port : 0)}/api/v1`;
  const onSecond = (from: Client) => {
    const c = new Client(base2);
    for (const name of ['ms_at', 'ms_rt']) {
      const v = from.jar.get(name);
      if (v) c.jar.set(name, v, '/api/v1');
    }
    c.shopId = from.shopId;
    return c;
  };

  const owner = await h.signIn('vapt-owner@medicineshop.test');
  owner.shopId = data<{ id: string }>(await owner.post('/shops', signup('Vapt Pharmacy'))).id;

  section('0. What the API gives away');
  const list = await owner.get('/products');
  check('no X-Powered-By (framework name)', !list.headers.get('x-powered-by'));
  check('no ETag (framework fingerprint; answers are no-store)', !list.headers.get('etag'));
  check('Permissions-Policy turns off camera, mic, location, payment', /camera=\(\)/.test(list.headers.get('permissions-policy') ?? ''));

  section('1. Query-string tricks');
  const op = await owner.get('/products?q[$ne]=x');
  check('?q[$ne]=x → 422, never a database operator', op.status === 422, code(op));
  const gt = await owner.get('/customers?search[$gt]=');
  check('?search[$gt]= → 422', gt.status === 422, code(gt));
  const twice = await owner.get('/products?q=a&q=b');
  check('the same key twice → 422, not 500', twice.status === 422, code(twice));
  const walk = await owner.get('/products/..%2F..%2F..%2Fetc%2Fpasswd');
  check('path traversal → 404 or 422, nothing read', [404, 422].includes(walk.status) && !/root:/.test(walk.text), code(walk));
  const nul = await owner.get('/products/%00');
  check('a NUL byte in the path → 4xx', nul.status >= 400 && nul.status < 500, code(nul));
  const badId = await owner.get('/sales/not-an-id');
  check('a bad id → 4xx without a stack trace', badId.status >= 400 && badId.status < 500 && !/\bat .+\.(ts|js):\d+/.test(badId.text), code(badId));

  section('2. Body tricks');
  const anon = h.client();
  const tok = await anon.loadCsrf();
  const proto = await anon.raw('POST', '/auth/otp/request', '{"email":"pp@medicineshop.test","__proto__":{"polluted":"yes"}}', { 'x-csrf-token': tok, 'content-type': 'application/json' });
  check('__proto__ in the body → 400, never reaches a route', proto.status === 400, code(proto));
  const ctor = await anon.raw('POST', '/auth/otp/request', '{"email":"pp@medicineshop.test","constructor":{"prototype":{"polluted":"yes"}}}', { 'x-csrf-token': tok, 'content-type': 'application/json' });
  check('constructor.prototype in the body → 400', ctor.status === 400, code(ctor));
  const nested = await anon.raw('POST', '/auth/otp/request', '{"email":"pp@medicineshop.test","x":[{"y":{"__proto__":{"polluted":"yes"}}}]}', { 'x-csrf-token': tok, 'content-type': 'application/json' });
  check('…however deep it hides → 400', nested.status === 400, code(nested));
  check('nothing reached Object.prototype', ({} as Record<string, unknown>).polluted === undefined);
  const deep = await anon.raw('POST', '/auth/otp/request', `${'['.repeat(5000)}${']'.repeat(5000)}`, { 'x-csrf-token': tok, 'content-type': 'application/json' });
  check('5,000-deep JSON → refused, the server stays up', deep.status >= 400 && deep.status < 500 && (await anon.get('/health')).status === 200, code(deep));

  section('3. Limits are windows that open again — never a permanent block');
  const store = new SharedStore('vapt-test:');
  store.init({ windowMs: 700 } as Parameters<typeof store.init>[0]);
  for (let i = 0; i < 3; i++) await store.increment('k');
  check('3 hits counted in the shared store', (await store.get('k'))?.totalHits === 3);
  await wait(800);
  check('after the window the count starts again at 1', (await store.increment('k')).totalHits === 1);
  await RateHitModel.init();
  check('rows clear themselves (TTL index on resetAt)', (await RateHitModel.collection.indexes()).some((i) => i.key.resetAt === 1 && i.expireAfterSeconds === 0));

  const busy = await h.signIn('vapt-busy@medicineshop.test');
  let first429 = 0;
  for (let i = 1; i <= 70 && !first429; i++) if ((await busy.get('/auth/me')).status === 429) first429 = i;
  check('one person: 60 calls a minute, the 61st → 429', first429 === 61, `first 429 at call ${String(first429)}`);
  const last = await busy.get('/auth/me');
  check('the 429 says to try again later', last.status === 429 && /try again/i.test(last.json.error?.message ?? ''), code(last));
  check('health is never limited (uptime monitors)', (await busy.get('/health')).status === 200);
  check('another person is not slowed by it', (await (await h.signIn('vapt-calm@medicineshop.test')).get('/auth/me')).status === 200);

  let files429 = 0;
  for (let i = 1; i <= 5 && !files429; i++) if ((await owner.get('/products/export')).status === 429) files429 = i;
  check('Excel / PDF files: 3 a minute, the 4th → 429', files429 === 4, `first 429 at file ${String(files429)}`);
  const fileMsg = await owner.get('/products/export');
  check('…with its own message', /too many downloads/i.test(fileMsg.json.error?.message ?? ''), code(fileMsg));
  check('ordinary calls go on meanwhile', (await owner.get('/products')).status === 200);

  section('4. A second worker: same sessions, same limits');
  const roamer = await h.signIn('vapt-roam@medicineshop.test');
  const there = onSecond(roamer);
  check('signed in on worker 1 → known on worker 2', (await there.get('/auth/me')).status === 200);
  await roamer.post('/auth/logout', {});
  check('signed out on worker 1 → refused on worker 2 at once', (await there.get('/auth/me')).status === 401);

  const one = h.client();
  const two = new Client(base2);
  const email = 'vapt-otp@medicineshop.test';
  const tries = [await one.post('/auth/otp/request', { email }), await two.post('/auth/otp/request', { email }), await one.post('/auth/otp/request', { email })];
  check('3 code requests across both workers → all sent', tries.every((r) => r.status === 200), tries.map(code).join(' | '));
  const fourth = await two.post('/auth/otp/request', { email });
  check('the 4th, on the other worker → 429 (one shared count)', fourth.status === 429, code(fourth));
  check('the count lives in the database, not in one worker', (await RateHitModel.countDocuments({ _id: { $regex: /^rl:otp-req:/ } })) >= 1);

  const rows = [
    { name: 'Vapt Dolo 650', batch: 'VD1', expiry: '03/28', quantity: '10', mrp: '30.00', rate: '21.00' },
    { name: 'Vapt Azithral', batch: 'VA1', expiry: '2028-01', quantity: '20', mrp: '119.50', rate: '80' },
  ];
  const id = randomUUID();
  const imp = await owner.post('/products/import', { clientRequestId: id, dryRun: false, rows });
  check('import saved on worker 1', imp.status === 200, code(imp));
  const watcher = onSecond(owner);
  let seen = { done: 0, total: 0 };
  for (let i = 0; i < 20 && !(seen.total && seen.done === seen.total); i++) {
    seen = data<{ done: number; total: number }>(await watcher.get(`/products/import/progress/${id}`));
    if (!(seen.total && seen.done === seen.total)) await wait(100);
  }
  check('its progress reads the same on worker 2', seen.total === rows.length + 1 && seen.done === seen.total, JSON.stringify(seen));

  section('5. The minute scheduler runs on one worker');
  const t0 = new Date('2026-10-24T05:00:00Z');
  check('worker A takes the lease', await leader(t0, 'A'));
  check('worker B does not, while A holds it', !(await leader(t0, 'B')));
  check('A renews it a minute later', await leader(new Date(t0.getTime() + 60_000), 'A'));
  check('A stops (crash, restart): B takes over once it lapses', await leader(new Date(t0.getTime() + 60_000 + 91_000), 'B'));
  check('…and A, back, does not snatch it', !(await leader(new Date(t0.getTime() + 60_000 + 92_000), 'A')));

  section('6. The Speed panel adds up every worker');
  await PerfWorkerModel.create({ _id: 'vapt-other:1', since: new Date(Date.now() - 3_600_000), at: new Date(), routes: [{ path: 'GET /vapt-only', n: 5, ms: 500, max: 200, dbMs: 100, queries: 10, slow: 0 }] });
  await PerfWorkerModel.create({ _id: 'vapt-gone:1', since: new Date(Date.now() - 7_200_000), at: new Date(Date.now() - 10 * 60_000), routes: [{ path: 'GET /vapt-gone', n: 9, ms: 900, max: 100, dbMs: 0, queries: 0, slow: 0 }] });
  const perf = await perfOverview();
  check('two live workers counted (a silent one left out)', perf.workers.length === 2, JSON.stringify(perf.workers));
  check('the other worker’s routes are in the totals', perf.routes.some((r) => r.path === 'GET /vapt-only' && r.n === 5) && !perf.routes.some((r) => r.path === 'GET /vapt-gone'));

  await new Promise<void>((done) => second.close(() => { done(); }));
  await h.close();
  finish();
}

main().catch(crash);
