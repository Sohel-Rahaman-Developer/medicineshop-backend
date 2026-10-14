// Every screen's GET on the demo shop (60 days of trading) with the live server's database round trip added to each
// query, so a chain of awaits shows up here as it does in production. Not a gate: prints the slowest first.
import mongoose from 'mongoose';
import { startHarness, type Client, type Res } from './lib/harness';

const LATENCY_MS = Number(process.env.PROBE_LATENCY_MS ?? 61);
const SLOW_MS = 600;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let latency = false;
function delayExec(proto: { exec: (...args: unknown[]) => Promise<unknown> }) {
  const exec = proto.exec;
  proto.exec = async function (this: unknown, ...args: unknown[]) {
    if (latency) await sleep(LATENCY_MS);
    return exec.apply(this, args);
  };
}

async function main() {
  Object.assign(process.env, { RATE_OTP_REQUEST_PER_EMAIL: '100', RATE_OTP_VERIFY_PER_EMAIL: '100', RATE_API_PER_USER_PER_MIN: '100000' });
  const h = await startHarness();
  delayExec(mongoose.Query.prototype);
  delayExec(mongoose.Aggregate.prototype);
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  await AdminUserModel.create({ email: 'root@probe.test', name: 'Root', role: 'super' });
  const root = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('root@probe.test', '135790', 'admin');
  const secret = data<{ secret?: string }>(await root.post('/admin/auth/verify', { email: 'root@probe.test', otp: '135790' })).secret ?? '';
  await root.post('/admin/auth/totp', { code: totpAt(secret, Math.floor(Date.now() / 30_000)) });
  await root.post('/admin/demo', { reason: 'Latency probe' });
  type Info = { shop: { id: string } | null; job: { state: string } | null };
  let info = data<Info>(await root.get('/admin/demo'));
  while (info.job?.state === 'running') {
    await sleep(2000);
    info = data<Info>(await root.get('/admin/demo'));
  }
  await root.put('/admin/demo/code', { code: '482916', reason: 'Latency probe code' });
  const shop: Client = h.client();
  await shop.post('/auth/otp/request', { email: 'demo@medbox24.in' });
  await shop.post('/auth/otp/verify', { email: 'demo@medbox24.in', otp: '482916' });
  shop.shopId = info.shop?.id ?? '';

  const first = async (path: string) => data<{ id: string }[]>(await shop.get(path))[0]?.id ?? '';
  const [customer, product, sale, supplier, purchase] = await Promise.all(['/customers?limit=1', '/products?limit=1', '/sales?limit=1', '/suppliers?limit=1', '/purchases?limit=1'].map(first));
  const now = new Date(Date.now() + 5.5 * 3600_000);
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const from = `${month}-01`;
  const paths = [
    '/auth/me', '/shop/context', '/platform', '/release', '/notifications', '/notifications?all=true', '/notifications/preferences', '/notifications/settings',
    `/dashboard?from=${from}&to=${today}`, `/dashboard/charts?from=${from}&to=${today}`,
    '/pos/settings', '/pos/search?q=dolo&limit=12', '/search?q=dolo', '/categories', '/racks', '/tax', '/shop', '/subscription', '/subscription/payments', '/referral',
    '/products?limit=30', '/products/summary', '/products/companies', `/products/${product}`, `/products/${product}/batches`, `/products/${product}/received`, `/products/${product}/similar`,
    '/stock/expiry?bucket=d30&limit=50', '/stock/expiry/aging', '/stock/reorder', '/stock/movements?limit=30', '/stock/movements/people', '/stock/adjustments?limit=30', '/demands',
    '/sales?limit=30', `/sales/summary?from=${from}&to=${today}`, `/sales/${sale}`, '/sale-returns?limit=30', '/orders?limit=30', '/orders/summary',
    '/customers?limit=30', '/customers/summary', `/customers/${customer}`, `/customers/${customer}/ledger`, `/customers/${customer}/points-link`,
    '/loyalty/settings', '/loyalty/summary', '/loyalty/transactions?limit=30', '/loyalty/counter',
    '/suppliers?limit=30', '/suppliers/summary', '/suppliers/chart', `/suppliers/${supplier}`, `/suppliers/${supplier}/ledger`, `/suppliers/${supplier}/open-invoices`, `/suppliers/${supplier}/products`,
    '/purchases?limit=30', `/purchases/summary?from=${from}&to=${today}`, `/purchases/${purchase}`, '/purchase-returns?limit=30',
    '/expenses?limit=30', '/expenses/summary', '/day-close', '/day-close/history',
    `/reports/pnl?from=${from}&to=${today}`, '/reports/pnl/months', `/reports/gst?month=${month}`, `/reports/daybook?month=${month}`, '/reports/catalog', `/reports/analytics?tab=sales&from=${from}&to=${today}`,
    '/audit?limit=50', '/audit/filters', '/staff', '/staff/roles', '/roles', '/invitations', '/doctors', '/clinic/dues', `/clinic/day?day=${today}`,
    '/shop/terms', '/shop/files', '/support-access', '/auth/sessions', '/ai/wallet', '/ai/offer', '/ask/offer',
  ];

  latency = true;
  const rows: { path: string; status: number; ms: number; queries: number }[] = [];
  for (const path of paths) {
    let best = Infinity;
    let status = 0;
    let queries = 0;
    for (let i = 0; i < 2; i++) {
      const t = performance.now();
      const r = await shop.get(path);
      best = Math.min(best, performance.now() - t);
      status = r.status;
      queries = Number(/desc="(\d+) queries"/.exec(r.headers.get('server-timing') ?? '')?.[1] ?? 0);
    }
    rows.push({ path: path.replace(/[a-f0-9]{24}/g, ':id'), status, ms: Math.round(best), queries });
  }
  rows.sort((a, b) => b.ms - a.ms);
  process.stdout.write(`\nWith ${String(LATENCY_MS)} ms per query — slowest first (≥ ${String(SLOW_MS)} ms marked):\n`);
  for (const r of rows) process.stdout.write(`${r.ms >= SLOW_MS ? '🐢' : '  '} ${String(r.ms).padStart(6)} ms  ${String(r.queries).padStart(3)} q  ${String(r.status)}  ${r.path}\n`);
  latency = false;
  await h.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
