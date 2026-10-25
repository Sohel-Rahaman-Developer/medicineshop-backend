// v1.25 checks: the owner opens a branch from the main shop — same state may share the GSTIN with its own bill series,
// another state needs its own GSTIN; settings, roles and medicines come along with no stock; no new free trial;
// "All branches" shows each shop today; only the owner sees it.
import { randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const units = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const MAIN_GSTIN = '19ABCDE1234F1Z5';

const shopBody = (name: string, gstin?: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE', ...(gstin ? { gstin } : {}) },
  termsVersion: '2026-10',
  agree: true,
});
const branch = (over: Record<string, unknown>) => ({
  name: 'Krishna Medical Salt Lake',
  address: { line1: 'CF-12 Sector 1', city: 'Salt Lake', state: 'West Bengal', pincode: '700064' },
  phone: '033 2321 5566',
  drugLicenseNumber: 'WB/KOL/RLF20B/2025/1102',
  drugLicenseExpiry: '2030-08',
  gst: 'main',
  billPrefix: 'SLT',
  ...over,
});

interface Row { id: string; name: string; gstin: string; billPrefix: string; main: boolean; here: boolean; plan: string | null; today: { sales: number; bills: number } }
interface Overview { rows: Row[]; total: { sales: number; bills: number; udhaar: number }; main: { name: string } | null; canAdd: boolean }

async function main() {
  const h = await startHarness();
  const { ShopModel } = await import('../src/modules/shops/shop.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { ProductModel } = await import('../src/modules/products/product.model.js');
  const { RoleModel } = await import('../src/modules/roles/role.model.js');

  const owner = await h.signIn('rohit@branch1.test');
  const mainId = data<{ id: string }>(await owner.post('/shops', shopBody('Krishna Medical', MAIN_GSTIN))).id;
  owner.shopId = mainId;
  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id;
  const mk = async (c: Client, name: string) => data<{ id: string }>(await c.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: '', reorderLevel: 5, reorderQuantity: 0 })).id;
  const dolo = await mk(owner, 'Dolo 650 Tablet');
  await mk(owner, 'Pan 40 Tablet');
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId: dolo, batchNumber: 'DL1', expiry: '2028-12', quantity: 150, mrp: 3000, purchaseRate: 1950 });
  await owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: 2, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: 6000 }] });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'sunita@branch1.test', name: 'Sunita', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('sunita@branch1.test');
  await cashier.post(`/invitations/${data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Sunita' });
  cashier.shopId = mainId;

  section('1. Same state, the main GSTIN, its own bill series');
  check('a cashier can’t see branches → 403', (await cashier.get('/branches')).status === 403);
  check('…nor open one → 403', (await cashier.post('/branches', branch({}))).status === 403);
  const one = await owner.get('/branches');
  check('alone: one row, the main shop, can add', data<Overview>(one).rows.length === 1 && data<Overview>(one).rows[0]?.main === true && data<Overview>(one).canAdd, code(one));
  check('the bill series the main shop uses (INV) → 422', (await owner.post('/branches', branch({ billPrefix: 'inv' }))).status === 422);
  check('a bad bill series → 422', (await owner.post('/branches', branch({ billPrefix: 'S' }))).status === 422);
  check('unknown fields → 422', (await owner.post('/branches', branch({ extra: 1 }))).status === 422);
  const made = await owner.post('/branches', branch({ billPrefix: 'slt' }));
  const b1 = data<{ id: string; copied: number; trialEnds: string | null }>(made);
  check('branch opened, both medicines copied', made.status === 201 && b1.copied === 2, code(made));
  const b1Shop = await ShopModel.findById(b1.id).lean();
  check('…shares the main GSTIN, with bill series SLT, linked to the main shop', b1Shop?.gstin === MAIN_GSTIN && b1Shop.settings.billing?.billPrefix === 'SLT' && String(b1Shop.mainShopId) === mainId);
  check('…the same roles as the main shop', (await RoleModel.countDocuments({ shopId: b1Shop?._id })) === roles.length);
  const mainSub = await SubscriptionModel.findOne({ shopId: mainId }).lean();
  const b1Sub = await SubscriptionModel.findOne({ shopId: b1.id }).lean();
  check('no new free trial: it ends with the main shop’s', b1Sub?.planCode === 'trial' && b1Sub.endDate.getTime() === mainSub?.endDate.getTime() && b1.trialEnds !== null);
  const me = data<{ shops: { shopId: string; branchOf: string | null }[] }>(await owner.get('/auth/me'));
  check('the shop list shows it as a branch of Krishna Medical', me.shops.find((s) => s.shopId === b1.id)?.branchOf === 'Krishna Medical' && me.shops.find((s) => s.shopId === mainId)?.branchOf === null);

  const there = await h.signIn('rohit@branch1.test');
  there.shopId = b1.id;
  const list = data<{ name: string; stock: { sellable: number } }[]>(await there.get('/products'));
  check('in the branch: the medicines, stock 0', list.length === 2 && list.every((p) => p.stock.sellable === 0), JSON.stringify(list.map((p) => [p.name, p.stock.sellable])));
  check('the main shop’s stock stays where it is', ((await ProductModel.findOne({ _id: dolo, shopId: mainId }).lean())?.stock.sellable ?? 0) > 0);
  const bDolo = list.find((p) => p.name === 'Dolo 650 Tablet') as unknown as { id: string };
  await there.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId: bDolo.id, batchNumber: 'DL9', expiry: '2028-12', quantity: 30, mrp: 3000, purchaseRate: 1950 });
  const sale = await there.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: bDolo.id, quantity: 1, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: 3000 }] });
  check('a bill in the branch is numbered in its own series (SLT-…)', sale.status === 201 && /^SLT-\d{4}-\d{2}-/.test(data<{ billNumber: string }>(sale).billNumber), code(sale));
  check('a branch can’t open branches → 409', (await there.post('/branches', branch({ billPrefix: 'XYZ' }))).status === 409);
  check('the same bill series again → 422', (await owner.post('/branches', branch({ name: 'Another', billPrefix: 'SLT' }))).status === 422);

  section('2. Another state needs its own GSTIN');
  const patna = { name: 'Krishna Medical Patna', address: { line1: 'Boring Road', city: 'Patna', state: 'Bihar', pincode: '800001' }, billPrefix: 'PAT' };
  check('the main GSTIN in Bihar → 422', (await owner.post('/branches', branch({ ...patna, gst: 'main' }))).status === 422);
  check('no GSTIN while the shop is registered → 422', (await owner.post('/branches', branch({ ...patna, gst: 'own' }))).status === 422);
  check('a West Bengal GSTIN on a Bihar address → 422', (await owner.post('/branches', branch({ ...patna, gst: 'own', gstin: '19ABCDE1234F2Z4' }))).status === 422);
  const pat = await owner.post('/branches', branch({ ...patna, gst: 'own', gstin: '10abcde1234f1z7' }));
  check('its own Bihar GSTIN → opened', pat.status === 201, code(pat));
  check('…stored in capitals', (await ShopModel.findById(data<{ id: string }>(pat).id).lean())?.gstin === '10ABCDE1234F1Z7');

  section('3. All branches, today');
  const all = data<Overview>(await owner.get('/branches'));
  const mainRow = all.rows.find((r) => r.main);
  const slt = all.rows.find((r) => r.billPrefix === 'SLT');
  check('three shops, the main one first', all.rows.length === 3 && all.rows[0]?.main === true && all.main?.name === 'Krishna Medical');
  check('today: main 1 bill ₹60, Salt Lake 1 bill ₹30, total ₹90', mainRow?.today.bills === 1 && mainRow.today.sales === 6000 && slt?.today.sales === 3000 && all.total.sales === 9000 && all.total.bills === 2, JSON.stringify(all.total));
  check('the same list from inside a branch, marking where you are', data<Overview>(await there.get('/branches')).rows.find((r) => r.here)?.billPrefix === 'SLT');
  const other = await h.signIn('mina@branch2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Mina Medical'))).id;
  check('another owner sees only their own shop', data<Overview>(await other.get('/branches')).rows.length === 1);
  const peek = await h.signIn('mina@branch2.test');
  peek.shopId = b1.id;
  check('…and can’t step into someone’s branch → 403', (await peek.get('/branches')).status === 403);

  await h.close();
  finish();
}

main().catch(crash);
