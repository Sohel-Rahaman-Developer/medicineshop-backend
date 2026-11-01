// D111 checks: prices from one place. The product page sets the sell price (blank = MRP) and the lowest price on every
// batch in stock together; a new product can bring its lowest price with its first stock; a floor above the sell price
// is refused. Every change is in the audit log.
import { randomUUID } from 'node:crypto';
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
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
type Batch = { id: string; batchNumber: string; minPrice: number | null };

async function main() {
  const h = await startHarness();
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { Types } = await import('mongoose');
  const owner = await h.signIn('rohit@prices1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const other = await h.signIn('mina@prices2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Mina Medical'))).id;
  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id;
  const product = (name: string, extra: Record<string, unknown> = {}) => ({ name, company: 'Micro Labs', salt: 'Paracetamol', strength: '650mg', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0, ...extra });
  const stock = (minPrice?: number | null) => ({ clientRequestId: randomUUID(), batchNumber: 'DL1', expiry: '2028-06', quantity: 150, mrp: 3200, purchaseRate: 2100, rack: '', ...(minPrice === undefined ? {} : { minPrice }) });
  const batches = async (id: string) => data<Batch[]>(await owner.get(`/products/${id}/batches`));

  section('1. A new product brings its lowest price with its first stock');
  const bad = await owner.post('/products', product('Dolo 650', { sellPrice: 3000, stock: stock(3100) }));
  check('a lowest price above the sell price → 422 on that box', bad.status === 422 && JSON.stringify(bad.json.error).includes('body.stock.minPrice'), code(bad));
  const made = await owner.post('/products', product('Dolo 650', { sellPrice: 3000, stock: stock(2800) }));
  const dolo = data<{ id: string }>(made).id;
  const b1 = await batches(dolo);
  check('sell ₹30, lowest ₹28 on the first batch', made.status === 201 && b1[0]?.minPrice === 2800, `${code(made)} ${JSON.stringify(b1)}`);

  section('2. One dialog on the product page: sell price and lowest price together');
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL2', expiry: '2029-01', quantity: 150, mrp: 3400, purchaseRate: 2200 });
  const set = await owner.put(`/products/${dolo}/prices`, { sellPrice: 3100, minPrice: 2900 });
  const r = data<{ sellPrice: number; minPrice: number; batches: number }>(set);
  const b2 = await batches(dolo);
  check('sell ₹31, lowest ₹29 on both batches in stock', set.status === 200 && r.sellPrice === 3100 && r.batches === 2 && b2.every((b) => b.minPrice === 2900), `${code(set)} ${JSON.stringify(b2)}`);
  check('…in the audit log: who, the sell price change and the lowest price', Boolean(await AuditLogModel.exists({ shopId: new Types.ObjectId(shopId), entityId: dolo, text: { $regex: 'set the prices of Dolo 650 · sell price ₹30.00 → ₹31.00 · lowest price ₹29.00 on 2 batches' } })));
  const mrp = await owner.put(`/products/${dolo}/prices`, { sellPrice: null, minPrice: null });
  const p = data<{ sellPrice: number | null }>(await owner.get(`/products/${dolo}`));
  check('blank both → sell at MRP, no lowest price', mrp.status === 200 && p.sellPrice === null && (await batches(dolo)).every((b) => b.minPrice === null), code(mrp));
  const keep = await owner.put(`/products/${dolo}/prices`, { sellPrice: 3000 });
  check('lowest price left out → only the sell price changes', keep.status === 200 && data<{ batches: number }>(keep).batches === 0);
  check('a lowest price above the sell price → 422', (await owner.put(`/products/${dolo}/prices`, { sellPrice: 3000, minPrice: 3050 })).status === 422);
  check('₹0 sell price → 422', (await owner.put(`/products/${dolo}/prices`, { sellPrice: 0 })).status === 422);
  check('another shop’s product → 404', (await other.put(`/products/${dolo}/prices`, { sellPrice: 3000 })).status === 404);

  await h.close();
  finish();
}

main().catch(crash);
