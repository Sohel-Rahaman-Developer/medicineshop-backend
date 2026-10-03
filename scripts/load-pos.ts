// B10 load check: many counters billing the same medicines at once. Correctness first (no double-sold stock, no
// duplicate bill numbers, ledger = batch), then speed (p50 / p95 per bill). Run: npm run load:pos [-- bills concurrency]
import { randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;

async function main() {
  // A busy shop: 3 counters. 150 bills need more stock than there is, so the last ones must be refused.
  const BILLS = Number(process.argv[2] ?? 150);
  const CONC = Number(process.argv[3] ?? 3);
  const h = await startHarness();
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { MovementModel } = await import('../src/modules/stock/movement.model.js');
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');

  const owner = await h.signIn('rohit@load1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Load Test Pharmacy'))).id;
  owner.shopId = shopId;
  await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 50 } });
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const products: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = data<{ id: string }>(await owner.post('/products', { name: `Load Med ${String(i)}`, company: 'Micro Labs', salt: `salt ${String(i)}`, strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
    // Two batches each, so FEFO splits under load; just enough stock that the last bills must be refused, not oversold.
    await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: id, batchNumber: `A${String(i)}`, expiry: '2027-06', quantity: 15 * 30, mrp: 3000, purchaseRate: 1950 });
    await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: id, batchNumber: `B${String(i)}`, expiry: '2028-06', quantity: 15 * 30, mrp: 3000, purchaseRate: 1950 });
    products.push(id);
  }
  const counters = [];
  for (let c = 0; c < CONC; c++) {
    await owner.post('/staff', { email: `cashier${String(c)}@load1.test`, name: `cashier${String(c)}`, roleId: roles.find((r) => r.key === 'cashier')?.id });
    const s = await h.signIn(`cashier${String(c)}@load1.test`);
    await s.post(`/invitations/${data<{ id: string }[]>(await s.get('/invitations'))[0]?.id ?? ''}/accept`, { name: `cashier${String(c)}` });
    s.shopId = shopId;
    counters.push(s);
  }

  section(`1. ${String(BILLS)} bills from ${String(CONC)} counters at once`);
  const times: number[] = [];
  let ok = 0;
  let refused = 0;
  let failed = 0;
  let next = 0;
  const started = Date.now();
  await Promise.all(counters.map(async (c) => {
    while (next < BILLS) {
      const n = next++;
      const items = [{ productId: products[n % 5], quantity: 2, unit: 'STRIP' }, { productId: products[(n + 1) % 5], quantity: 1, unit: 'STRIP' }];
      const t0 = Date.now();
      const r = await c.post('/sales', { clientRequestId: randomUUID(), items, payments: [{ mode: 'CASH', amount: 9000 }] });
      times.push(Date.now() - t0);
      if (r.status === 201) ok++;
      else if (r.status === 409 || r.status === 422) refused++;
      else failed++;
    }
  }));
  const secs = (Date.now() - started) / 1000;
  process.stdout.write(`  ${String(ok)} saved, ${String(refused)} refused (stock), ${String(failed)} errors · ${(ok / secs).toFixed(1)} bills/s · p50 ${String(pct(times, 50))} ms · p95 ${String(pct(times, 95))} ms\n`);
  check('no server errors under load', failed === 0, String(failed));

  section('2. The books still add up');
  const batches = await BatchModel.find({ shopId }).lean();
  const ledger = await MovementModel.aggregate<{ _id: string; q: number }>([{ $match: { shopId: batches[0]?.shopId } }, { $group: { _id: { $toString: '$batchId' }, q: { $sum: '$quantity' } } }]);
  check('every batch = the sum of its movements', batches.every((b) => ledger.find((l) => l._id === String(b._id))?.q === b.quantity));
  check('no batch below zero (nothing sold twice)', batches.every((b) => b.quantity >= 0));
  const sold = await SaleModel.aggregate<{ q: number }>([{ $match: { shopId: batches[0]?.shopId, status: { $ne: 'cancelled' } } }, { $unwind: '$lines' }, { $group: { _id: null, q: { $sum: '$lines.quantityInBase' } } }]);
  check('stock in − sold = stock left', 5 * 2 * 450 - (sold[0]?.q ?? 0) === batches.reduce((s, b) => s + b.quantity, 0));
  const nums = await SaleModel.find({ shopId: batches[0]?.shopId }).select('billNumber').lean();
  check(`${String(nums.length)} bills, every number different`, new Set(nums.map((x) => x.billNumber)).size === nums.length && nums.length === ok);
  check('the shop ran out exactly where it should (some refused, none oversold)', refused === 0 || batches.some((b) => b.quantity < 45));
  check(`p95 under 1.5 s on this machine (${String(pct(times, 95))} ms)`, pct(times, 95) < 1500);

  await h.close();
  finish();
}

main().catch(crash);
