// Load balancing check: real API workers (node:cluster, round robin — what PM2 cluster mode does on Linux) on one
// database. Counters bill and browse while the office downloads PDF reports, first on 1 worker, then on N; prints how the
// requests spread, req/s and p50 / p95; checks the scheduler lease passes to a live worker and the books still add up.
// Run: npm run build && npm run load:cluster [-- workers seconds counters]
import cluster, { type Worker } from 'node:cluster';
import { randomUUID } from 'node:crypto';
import { Client, check, crash, finish, out, section, type Res } from './lib/harness';

const WORKERS = Number(process.argv[2] ?? 2);
const SECONDS = Number(process.argv[3] ?? 20);
const COUNTERS = Number(process.argv[4] ?? 12);
const PORT = 5077;
const BASE = `http://127.0.0.1:${String(PORT)}/api/v1`;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const shopBody = { owner: { name: 'Rohit Agarwal', phone: '98300 41122' }, shop: { name: 'Cluster Load Pharmacy', address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' }, termsVersion: '2026-10', agree: true };

async function start(n: number, env: NodeJS.ProcessEnv): Promise<Worker[]> {
  const workers: Worker[] = [];
  await Promise.all(Array.from({ length: n }, () => new Promise<void>((done, fail) => {
    const w = cluster.fork({ ...env, API_WORKERS: String(n) });
    workers.push(w);
    w.once('listening', () => { done(); });
    w.once('exit', (code) => { fail(new Error(`worker exited with ${String(code)}`)); });
  })));
  return workers;
}

async function stop(workers: Worker[]) {
  await Promise.all(workers.map((w) => new Promise<void>((done) => {
    w.removeAllListeners('exit');
    w.once('exit', () => { done(); });
    w.kill('SIGTERM');
  })));
}

async function main() {
  // Windows defaults to the OS spreading connections; Linux (the server) to round robin — test what production runs.
  cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary({ exec: 'dist/server.js', silent: false });
  process.env.MONGOMS_LAUNCH_TIMEOUT ??= '120000';
  out('\n⏳ Starting in-memory MongoDB…\n');
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MONGODB_URI: rs.getUri('medicineshop_cluster'),
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    PORT: String(PORT),
    SHOP_APP_URL: 'http://localhost:3000',
    ADMIN_APP_URL: 'http://localhost:3001',
    JWT_ACCESS_SECRET: 'smoke-test-access-secret-0123456789abcdef',
    CSRF_SECRET: 'smoke-test-csrf-secret-0123456789abcdefgh', // gitleaks:allow
    COOKIE_SECURE: 'false',
    SMTP_HOST: '',
    DEV_STATIC_OTP: '',
    PAYMENTS_MODE: 'test',
    RAZORPAY_KEY_ID: 'rzp_test_local',
    RAZORPAY_KEY_SECRET: 'smoke-razorpay-key-secret',
    RAZORPAY_WEBHOOK_SECRET: 'smoke-razorpay-webhook-secret',
    JOBS_ENABLED: 'true',
    RATE_API_PER_USER_PER_MIN: '100000',
    RATE_FILES_PER_USER_PER_MIN: '100000',
    RATE_OTP_REQUEST_PER_IP: '1000',
  };
  Object.assign(process.env, env);
  const { connectDb, disconnectDb } = await import('../src/config/db.js');
  const { OtpTokenModel } = await import('../src/modules/auth/models/otp-token.model.js');
  const { hashOtp } = await import('../src/utils/crypto.js');
  const { LeaseModel } = await import('../src/modules/notifications/jobs.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { MovementModel } = await import('../src/modules/stock/movement.model.js');
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  await connectDb();
  const signIn = async (email: string) => {
    await OtpTokenModel.create({ audience: 'shop', email, otpHash: await hashOtp('424242'), maxAttempts: 5, expiresAt: new Date(Date.now() + 10 * 60_000) });
    const c = new Client(BASE);
    const r = await c.post('/auth/otp/verify', { email, otp: '424242' });
    if (r.status !== 200) throw new Error(`sign-in ${email}: ${String(r.status)} ${r.text}`);
    return c;
  };

  let workers = await start(1, env);
  section('Set-up: a shop, 5 medicines with plenty of stock, counters signed in');
  const owner = await signIn('owner@cluster.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody)).id;
  owner.shopId = shopId;
  await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 60 } });
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const products: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = data<{ id: string }>(await owner.post('/products', { name: `Cluster Med ${String(i)}`, company: 'Micro Labs', salt: `salt ${String(i)}`, strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
    await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: id, batchNumber: `C${String(i)}`, expiry: '2028-06', quantity: 15 * 20_000, mrp: 3000, purchaseRate: 1950 });
    products.push(id);
  }
  const counters: Client[] = [];
  for (let c = 0; c < COUNTERS; c++) {
    await owner.post('/staff', { email: `cashier${String(c)}@cluster.test`, name: `cashier${String(c)}`, roleId: roles.find((r) => r.key === 'cashier')?.id });
    const s = await signIn(`cashier${String(c)}@cluster.test`);
    await s.post(`/invitations/${data<{ id: string }[]>(await s.get('/invitations'))[0]?.id ?? ''}/accept`, { name: `cashier${String(c)}` });
    s.shopId = shopId;
    counters.push(s);
  }
  check(`${String(COUNTERS)} counters ready`, counters.length === COUNTERS);

  const rounds: { n: number; reqs: number; rps: number; p50: number; p95: number; pdfs: number; pdfP50: number; errors: number; spread: number[] }[] = [];
  for (const n of [1, WORKERS]) {
    if (n !== 1) {
      await stop(workers);
      workers = await start(n, env);
    }
    // Old keep-alive sockets point at stopped workers: a few calls each first.
    for (const c of counters) for (let i = 0; i < 2; i++) await c.get('/pos/settings').catch(() => undefined);
    section(`${String(SECONDS)} s of ${String(COUNTERS)} counters on ${String(n)} worker${n === 1 ? '' : 's'}`);
    const times: number[] = [];
    const by = new Map<string, number>();
    let errors = 0;
    let bills = 0;
    const until = Date.now() + SECONDS * 1000;
    // The office: a sales-register PDF after another — real CPU work in whichever worker builds it.
    const pdfTimes: number[] = [];
    const office = (async () => {
      while (Date.now() < until) {
        const t0 = performance.now();
        const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
        const r = await owner.raw('GET', `/reports/r/sales-register/export?format=pdf&from=${today}&to=${today}`).catch(() => null);
        if (r?.status === 200) pdfTimes.push(performance.now() - t0);
        else errors++;
      }
    })();
    await Promise.all(counters.map(async (c, ci) => {
      for (let i = 0; Date.now() < until; i++) {
        const pick = (i + ci) % 6;
        const t0 = performance.now();
        let r: Res;
        try {
          if (pick === 0) {
            r = await c.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: products[(i + ci) % 5], quantity: 1, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: 3000 }] });
            if (r.status === 201) bills++;
          } else if (pick === 1) r = await c.get('/sales?limit=20');
          else if (pick === 2) r = await c.get('/products?q=cluster');
          else r = await c.get(`/pos/search?q=clus${'ter med'.slice(0, i % 7)}`);
        } catch {
          errors++;
          continue;
        }
        times.push(performance.now() - t0);
        if (r.status >= 500 || r.status === 0) errors++;
        const w = r.headers.get('x-worker') ?? '?';
        by.set(w, (by.get(w) ?? 0) + 1);
      }
    }));
    await office;
    const spread = [...by.values()].sort((a, b) => b - a);
    const round = { n, reqs: times.length, rps: Math.round(times.length / SECONDS), p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), pdfs: pdfTimes.length, pdfP50: Math.round(pct(pdfTimes, 50)), errors, spread };
    rounds.push(round);
    out(`  counters: ${String(round.reqs)} requests (${String(bills)} bills) · ${String(round.rps)} req/s · p50 ${String(round.p50)} ms · p95 ${String(round.p95)} ms\n  office: ${String(round.pdfs)} PDFs, p50 ${String(round.pdfP50)} ms · errors ${String(errors)}\n  per worker: ${spread.join(' / ')}\n`);
    check('no server errors', errors === 0, String(errors));
    check(`every worker took part (${String(by.size)} of ${String(n)})`, by.size === n);
    if (n > 1) {
      const low = Math.min(...spread);
      const high = Math.max(...spread);
      check('the load spreads evenly (busiest ≤ 1.5 × quietest)', high <= low * 1.5, `${String(low)}–${String(high)}`);
    }
    // Workers stopped hard (a crash; Windows has no SIGINT) keep it until it lapses at 90 s, then a live worker takes it.
    const pids = workers.map((w) => w.process.pid);
    const held = async () => {
      const lease = await LeaseModel.findById('scheduler').lean();
      return Boolean(lease && lease.until > new Date() && pids.some((p) => lease.owner.endsWith(`:${String(p)}`)));
    };
    const waitFrom = Date.now();
    while (!(await held()) && Date.now() - waitFrom < 170_000) await new Promise((done) => setTimeout(done, 2000));
    check(`the scheduler lease is with one live worker (waited ${String(Math.round((Date.now() - waitFrom) / 1000))} s)`, await held());
  }

  section('The books still add up');
  await stop(workers);
  const batches = await BatchModel.find({ shopId }).lean();
  const ledger = await MovementModel.aggregate<{ _id: string; q: number }>([{ $match: { shopId: batches[0]?.shopId } }, { $group: { _id: { $toString: '$batchId' }, q: { $sum: '$quantity' } } }]);
  check('every batch = the sum of its movements', batches.every((b) => ledger.find((l) => l._id === String(b._id))?.q === b.quantity));
  const nums = await SaleModel.find({ shopId: batches[0]?.shopId }).select('billNumber').lean();
  check(`${String(nums.length)} bills, every number different`, new Set(nums.map((x) => x.billNumber)).size === nums.length);
  const [one, many] = rounds;
  if (one && many) out(`\n  1 worker: ${String(one.rps)} req/s, p95 ${String(one.p95)} ms, ${String(one.pdfs)} PDFs   →   ${String(many.n)} workers: ${String(many.rps)} req/s, p95 ${String(many.p95)} ms, ${String(many.pdfs)} PDFs\n`);

  await disconnectDb();
  await rs.stop();
  finish();
}

main().catch(crash);
