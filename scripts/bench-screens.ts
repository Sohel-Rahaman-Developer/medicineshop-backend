// Speed check for the screens a busy shop opens all day: a year of bills, 3000 products, then every GET the shop app
// sends, timed with its database round trips counted. Run: npm run bench:screens [-- bills copies]
import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { crash, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const must = async <T>(what: string, p: Promise<Res>): Promise<T> => {
  const r = await p;
  if (r.status !== 200 && r.status !== 201) throw new Error(`${what}: ${String(r.status)} ${r.text.slice(0, 300)}`);
  return data<T>(r);
};
const KEYS = ['name', 'company', 'salt', 'strength', 'category', 'schedule', 'gst', 'hsn', 'barcode', 'saleUnit', 'baseUnit', 'pack', 'purchaseUnit', 'purchasePack', 'storage', 'hasExpiry', 'batch', 'expiry', 'quantity', 'mrp', 'rate', 'minPrice', 'rack'] as const;
const BRANDS = ['Dolo', 'Pan', 'Azithral', 'Montair', 'Telma', 'Glycomet', 'Shelcal', 'Becosules', 'Allegra', 'Calpol', 'Zerodol', 'Omez', 'Augmentin', 'Ecosprin', 'Amlong', 'Thyronorm', 'Rosuvas', 'Neurobion', 'Limcee', 'Cetzine'];
const COMPANIES = ['Micro Labs', 'Sun Pharma', 'Cipla', 'Alkem', 'Glenmark', 'USV', 'Torrent', 'Abbott', 'Lupin', 'Mankind'];
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const PRODUCTS = 3000;
  const BILLS = Number(process.argv[2] ?? 1500);
  const COPIES = Number(process.argv[3] ?? 30);
  const h = await startHarness();
  const mongoose = (await import('mongoose')).default;
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { MovementModel } = await import('../src/modules/stock/movement.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');

  section(`Setup: ${String(PRODUCTS)} products, ${String(BILLS)} bills × ${String(COPIES + 1)} over a year`);
  const t0 = Date.now();
  const owner = await h.signIn('owner@bench.test');
  const shopId = (await must<{ id: string }>('shop', owner.post('/shops', {
    owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
    shop: { name: 'Bench Pharmacy', address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
    termsVersion: '2026-10',
    agree: true,
  }))).id;
  owner.shopId = shopId;
  await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 10 } });

  for (let start = 0; start < PRODUCTS; start += 200) {
    const rows = Array.from({ length: Math.min(200, PRODUCTS - start) }, (_, k) => {
      const i = start + k;
      const v = ['', `${BRANDS[i % 20] ?? ''} ${String(100 + i)} Tablet`, COMPANIES[i % 10] ?? '', `salt ${String(i % 400)}`, `${String(5 + (i % 50) * 10)} mg`, 'Tablet', i % 7 === 0 ? 'H' : 'OTC', 12, '30049099', '', 'STRIP', 'TABLET', 10, 'BOX', 10, 'Normal', 'Yes', `B${String(i)}`, `0${String(1 + (i % 9))}/28`, 400, 50 + (i % 300), 35 + (i % 200), '', `R-${String(i % 60)}`];
      return Object.fromEntries(KEYS.map((key, j) => [key, v[j + 1] ?? '']));
    });
    await must('import', owner.post('/products/import', { clientRequestId: randomUUID(), dryRun: false, rows }));
  }
  const ids: string[] = [];
  for (let cursor: string | undefined; ;) {
    const r = await owner.get(`/products?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    ids.push(...data<{ id: string }[]>(r).map((p) => p.id));
    cursor = (r.json as { meta?: { nextCursor?: string } }).meta?.nextCursor;
    if (!cursor) break;
  }
  const customers: string[] = [];
  for (let i = 0; i < 200; i++) customers.push((await must<{ id: string }>('customer', owner.post('/customers', { name: `Customer ${String(i)}`, phone: `98${String(30_000_000 + i)}`, creditLimit: 500_000 }))).id);
  const suppliers: string[] = [];
  for (let i = 0; i < 20; i++) suppliers.push((await must<{ id: string }>('supplier', owner.post('/suppliers', { name: `Supplier ${String(i)}`, phone: `97${String(40_000_000 + i)}`, contactPerson: '', email: '', gstin: '', drugLicense: '', address: 'Bagri Market', creditDays: 30 }))).id);
  for (let i = 0; i < 200; i++) {
    const lines = Array.from({ length: 5 }, (_, k) => ({ productId: ids[(i * 5 + k) % ids.length], batchNumber: `P${String(i)}-${String(k)}`, expiry: '2029-06', quantity: 20, freeQuantity: 0, unit: 'STRIP', discountPercent: 0, gstRate: 12, rack: '', rate: 3000, mrp: 4500 }));
    await must('purchase', owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: suppliers[i % 20], invoiceNumber: `INV-${String(i)}`, invoiceDate: ist(new Date()), lines, payment: { mode: 'CASH', amount: 0 } }).then((r) => (r.status === 422 ? owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: suppliers[i % 20], invoiceNumber: `INV-${String(i)}`, invoiceDate: ist(new Date()), lines }) : r)));
  }
  process.stdout.write(`  catalogue + 200 customers + 200 purchases in ${String(Math.round((Date.now() - t0) / 1000))} s\n`);

  const billTimes: number[] = [];
  for (let i = 0; i < BILLS; i++) {
    const items = Array.from({ length: 1 + (i % 4) }, (_, k) => ({ productId: ids[(i * 7 + k * 13) % ids.length], quantity: 1, unit: 'STRIP' }));
    const extra = i % 5 === 0 ? { customerId: customers[i % customers.length] } : {};
    const quote = await owner.post('/sales', { clientRequestId: randomUUID(), items, payments: [], expectedTotal: 0, ...extra });
    const total = (quote.json.error as { details?: { total?: number } } | undefined)?.details?.total ?? 0;
    const s = Date.now();
    await must('bill', owner.post('/sales', { clientRequestId: randomUUID(), items, payments: [{ mode: i % 3 ? 'CASH' : 'UPI', amount: total, reference: '' }], ...extra }));
    billTimes.push(Date.now() - s);
  }
  process.stdout.write(`  ${String(BILLS)} bills · p50 ${String(pct(billTimes, 50))} ms · p95 ${String(pct(billTimes, 95))} ms per bill\n`);

  // Copies of those bills and their stock movements, spread back over a year, so reports read a year of history.
  const sid = new mongoose.Types.ObjectId(shopId);
  const sales = await SaleModel.find({ shopId: sid }).lean();
  const moves = await MovementModel.find({ shopId: sid, type: 'SALE' }).lean();
  const DAY = 86_400_000;
  for (let c = 1; c <= COPIES; c++) {
    const shift = Math.round((c / (COPIES + 1)) * 360) * DAY;
    const map = new Map<string, Types.ObjectId>();
    await SaleModel.collection.insertMany(sales.map((s) => {
      const _id = new mongoose.Types.ObjectId();
      map.set(String(s._id), _id);
      return { ...s, _id, billNumber: `${s.billNumber}-${String(c)}`, clientRequestId: randomUUID(), billDate: new Date(s.billDate.getTime() - shift), createdAt: new Date(s.billDate.getTime() - shift) };
    }), { ordered: false });
    await MovementModel.collection.insertMany(moves.map((m) => ({ ...m, _id: new mongoose.Types.ObjectId(), ...(m.refId ? { refId: map.get(String(m.refId)) ?? m.refId } : {}), at: new Date(m.at.getTime() - shift) })), { ordered: false });
  }
  process.stdout.write(`  ${String(await SaleModel.countDocuments({ shopId: sid }))} bills, ${String(await MovementModel.countDocuments({ shopId: sid }))} movements in ${String(Math.round((Date.now() - t0) / 1000))} s\n`);

  // Every database command the request makes, counted; the harness runs no jobs, so all of them are the request's.
  let ops = 0;
  mongoose.set('debug', () => {
    ops++;
  });
  const today = new Date();
  const from = ist(new Date(today.getTime() - 29 * DAY));
  const to = ist(today);
  const yearFrom = ist(new Date(today.getTime() - 364 * DAY));
  const month = to.slice(0, 7);
  const pid = ids[42] ?? '';
  const cid = customers[0] ?? '';
  const sale = await must<{ id: string }[]>('sales', owner.get('/sales?limit=1'));
  const catalog = await must<{ key: string }[]>('catalog', owner.get('/reports/catalog'));
  const routes: [string, string][] = [
    ['session', '/auth/me'], ['shop context', '/shop/context'], ['notifications', '/notifications'],
    ['home (30 days)', `/dashboard?from=${from}&to=${to}`], ['home charts (30 days)', `/dashboard/charts?from=${from}&to=${to}`],
    ['home (year)', `/dashboard?from=${yearFrom}&to=${to}`], ['home charts (year)', `/dashboard/charts?from=${yearFrom}&to=${to}`],
    ['POS search "dol"', '/pos/search?q=dol&limit=12'], ['POS search "azithral 1"', '/pos/search?q=azithral%201&limit=12'], ['POS settings', '/pos/settings'],
    ['global search', '/search?q=dol'],
    ['products page 1', '/products?limit=30'], ['products summary', '/products/summary'], ['product', `/products/${pid}`], ['product batches', `/products/${pid}/batches`],
    ['expiry', '/stock/expiry?limit=50'], ['expiry aging', '/stock/expiry/aging'], ['reorder', '/stock/reorder'],
    ['movements', '/stock/movements?limit=30'],
    ['sales page 1', '/sales?limit=30'], ['sales summary (30 days)', `/sales/summary?from=${from}&to=${to}`], ['sale', `/sales/${sale[0]?.id ?? ''}`],
    ['purchases page 1', '/purchases?limit=30'], ['purchases summary', `/purchases/summary?from=${from}&to=${to}`],
    ['customers page 1', '/customers?limit=30'], ['customers summary', '/customers/summary'], ['customer', `/customers/${cid}`], ['customer ledger', `/customers/${cid}/ledger`],
    ['suppliers', '/suppliers?limit=30'], ['suppliers summary', '/suppliers/summary'],
    ['day close', '/day-close'], ['P&L (30 days)', `/reports/pnl?from=${from}&to=${to}`], ['P&L months', '/reports/pnl/months'], ['day book', `/reports/daybook?month=${month}`], ['GST month', `/reports/gst?month=${month}`],
    ...(['sales', 'stock', 'customers', 'suppliers'].map((tab) => [`analytics ${tab} (year)`, `/reports/analytics?tab=${tab}&from=${yearFrom}&to=${to}`] as [string, string])),
    ...catalog.map((r) => [`report ${r.key}`, `/reports/r/${r.key}?from=${from}&to=${to}`] as [string, string]),
  ];

  section(`Screens: ${String(routes.length)} requests, median of 5 runs each`);
  const rows: { name: string; ms: number; ops: number; status: number; kb: number }[] = [];
  for (const [name, path] of routes) {
    const times: number[] = [];
    let status = 0;
    let count = 0;
    let kb = 0;
    for (let k = 0; k < 5; k++) {
      ops = 0;
      const s = performance.now();
      const r = await (owner).get(path);
      times.push(performance.now() - s);
      status = r.status;
      count = ops;
      kb = r.body.length / 1024;
    }
    rows.push({ name, ms: pct(times, 50), ops: count, status, kb });
  }
  mongoose.set('debug', false);
  rows.sort((a, b) => b.ms - a.ms);
  for (const r of rows) process.stdout.write(`  ${r.status === 200 ? ' ' : '!'} ${r.name.padEnd(34)} ${r.ms.toFixed(0).padStart(6)} ms  ${String(r.ops).padStart(3)} db  ${r.kb.toFixed(1).padStart(7)} KB${r.status === 200 ? '' : `  (${String(r.status)})`}\n`);
  await h.close();
  process.exit(0);
}

main().catch(crash);
