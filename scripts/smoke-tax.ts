// D62 checks: the shop's own tax list, products pick from it, bills keep their rate, changes are audited.
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

interface Rate { name: string; rate: number; products?: number }
interface Tax { rates: Required<Rate>[]; defaultGstRate: number; showHsnOnBill: boolean }
interface Line { gstRate: number; totalAmount: number; taxableAmount: number; cgst: number; sgst: number }
interface Sale { lines: Line[]; taxableAmount: number; totalTax: number }

const IST = 5.5 * 60 * 60 * 1000;
const isoDay = (offsetDays = 0) => new Date(Date.now() + IST + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const h = await startHarness();
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');

  const owner = await h.signIn('rohit@tax1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const product = (name: string, gstRate: number) => ({ name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'sunita@tax1.test', name: 'sunita', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('sunita@tax1.test');
  await cashier.post(`/invitations/${data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'sunita' });
  cashier.shopId = shop1;

  section('1. A new shop starts with the old slabs (nothing changes until the owner edits)');
  const t0 = data<Tax>(await owner.get('/tax'));
  check('No tax 0 · GST 5 · 12 · 18 · 28 · 40, default 12, HSN on', t0.rates.map((r) => `${r.name}=${String(r.rate)}`).join(',') === 'No tax=0,GST 5%=5,GST 12%=12,GST 18%=18,GST 28%=28,GST 40%=40' && t0.defaultGstRate === 12 && t0.showHsnOnBill, JSON.stringify(t0));
  const cRead = await cashier.get('/tax');
  check('cashier reads the list (the product form needs it)', cRead.status === 200, code(cRead));
  const body = (rates: Rate[], over: Record<string, unknown> = {}) => ({ rates, defaultGstRate: 12, showHsnOnBill: true, ...over });
  const withNew = [...t0.rates.map((r) => ({ name: r.name, rate: r.rate })), { name: 'GST 3%', rate: 3 }, { name: 'Special 2.5%', rate: 2.5 }];
  check('cashier can’t change it → 403', (await cashier.put('/tax', body(withNew))).status === 403);

  section('2. Products only take a rate from the list');
  const off = await owner.post('/products', product('Gold Bhasma', 3));
  check('3% before it is in the list → 422, says where to add it', off.status === 422 && /Settings → Tax/.test(off.json.error?.message ?? ''), code(off));
  check('0 = no tax is a normal choice', (await owner.post('/products', product('Cotton Roll', 0))).status === 201);

  section('3. The owner edits the list');
  const bad = await Promise.all([
    body([...withNew, { name: 'Again', rate: 3 }]),
    body([...withNew, { name: 'gst 3%', rate: 4 }]),
    body(withNew, { defaultGstRate: 7 }),
    body([{ name: 'Huge', rate: 101 }], { defaultGstRate: 101 }),
    body([{ name: 'Odd', rate: 2.555 }], { defaultGstRate: 2.555 }),
    body([]),
  ].map((b) => owner.put('/tax', b)));
  check('same rate twice / same name twice / default not in the list / 101 % / 3 decimals / empty → 422', bad.every((r) => r.status === 422), bad.map((r) => r.status).join(','));
  const saved = await owner.put('/tax', body(withNew));
  const t1 = data<Tax>(saved);
  check('adds GST 3% and Special 2.5% → sorted by rate', saved.status === 200 && t1.rates.map((r) => r.rate).join(',') === '0,2.5,3,5,12,18,28,40', code(saved));
  const a1 = await AuditLogModel.findOne({ shopId: shop1, entityName: 'Tax rates' }).sort({ _id: -1 }).lean();
  const ch = a1?.changes as { before: { rates: Rate[] }; after: { rates: Rate[] } } | undefined;
  check('audit: who, what, old → new', a1?.userName === 'Rohit Agarwal' && /added Special 2\.5% \(2\.5%\) · added GST 3% \(3%\)/.test(a1.text) && ch?.before.rates.length === 6 && ch.after.rates.length === 8, a1?.text);

  section('4. Bills: same MRP-inclusive maths, decimals exact');
  const dolo = data<{ id: string }>(await owner.post('/products', product('Dolo 650 Tablet', 12))).id;
  const spec = data<{ id: string }>(await owner.post('/products', product('Special Tonic', 2.5))).id;
  check('product at 2.5% → saved', Boolean(spec));
  for (const [id, b, mrp] of [[dolo, 'DL1', 3000], [spec, 'SP1', 10_000]] as const) await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: id, batchNumber: b, expiry: '2028-12', quantity: 150, mrp, purchaseRate: 1000 });
  const sell = async (id: string, amount: number) => data<{ id: string }>(await owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: id, quantity: 1, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount }] })).id;
  const getSale = async (id: string) => data<Sale>(await owner.get(`/sales/${id}`));
  const s12 = await getSale(await sell(dolo, 3000));
  check('₹30 at 12% → taxable 26.79, CGST 1.61, SGST 1.60 (PLAN §14, unchanged)', s12.lines[0]?.taxableAmount === 2679 && s12.lines[0].cgst === 161 && s12.lines[0].sgst === 160, JSON.stringify(s12.lines[0]));
  const spBill = await sell(spec, 10_000);
  const s25 = await getSale(spBill);
  check('₹100 at 2.5% → taxable 97.56 (100 × 100 ÷ 102.5), tax 2.44 split 1.22 + 1.22', s25.lines[0]?.gstRate === 2.5 && s25.lines[0].taxableAmount === 9756 && s25.lines[0].cgst === 122 && s25.lines[0].sgst === 122, JSON.stringify(s25.lines[0]));

  section('5. A rate change never touches old bills (snapshot)');
  const p = data<{ version: number } & Record<string, unknown>>(await owner.get(`/products/${spec}`));
  const upd = await owner.put(`/products/${spec}`, { ...product('Special Tonic', 5), version: p.version });
  check('owner moves Special Tonic 2.5% → 5%', upd.status === 200, code(upd));
  const a2 = await AuditLogModel.findOne({ shopId: shop1, module: 'products', entityId: spec, action: 'update' }).sort({ _id: -1 }).lean();
  check('audit names the GST change with old and new', /GST 2\.5% → 5%/.test(a2?.text ?? '') && JSON.stringify(a2?.changes) === JSON.stringify({ before: { gstRate: 2.5 }, after: { gstRate: 5 } }), a2?.text);
  const again = await getSale(spBill);
  check('the old bill still says 2.5% and 97.56', again.lines[0]?.gstRate === 2.5 && again.lines[0].taxableAmount === 9756);
  const s5 = await getSale(await sell(spec, 10_000));
  check('a new bill uses 5% → taxable 95.24', s5.lines[0]?.gstRate === 5 && s5.lines[0].taxableAmount === 9524, JSON.stringify(s5.lines[0]));

  section('6. A rate in use can’t be removed');
  const t2 = data<Tax>(await owner.get('/tax'));
  check('the list counts products per rate', t2.rates.find((r) => r.rate === 5)?.products === 1 && t2.rates.find((r) => r.rate === 2.5)?.products === 0 && t2.rates.find((r) => r.rate === 12)?.products === 1);
  const keep = (drop: number[]) => t2.rates.filter((r) => !drop.includes(r.rate)).map((r) => ({ name: r.name, rate: r.rate }));
  const busy = await owner.put('/tax', body(keep([5])));
  check('remove GST 5% while a product uses it → 409, names it', busy.status === 409 && (busy.json.error?.details as { reason?: string } | undefined)?.reason === 'TAX_RATE_IN_USE' && /GST 5% is on 1 product/.test(busy.json.error?.message ?? ''), code(busy));
  const free = await owner.put('/tax', body(keep([28, 40, 2.5]).map((r) => (r.rate === 0 ? { name: 'Exempt', rate: 0 } : r)), { defaultGstRate: 5, showHsnOnBill: false }));
  check('remove unused 28 / 40 / 2.5, rename No tax → Exempt, default 5, HSN off → saved', free.status === 200 && data<Tax>(free).rates.map((r) => r.rate).join(',') === '0,3,5,12,18' && data<Tax>(free).defaultGstRate === 5, code(free));
  const a3 = await AuditLogModel.findOne({ shopId: shop1, entityName: 'Tax rates' }).sort({ _id: -1 }).lean();
  check('audit lists each change', ['removed GST 28%', 'removed GST 40%', 'renamed No tax → Exempt', 'default 12% → 5%', 'HSN on the bill off'].every((x) => a3?.text.includes(x)), a3?.text);
  check('product at 28% now → 422', (await owner.post('/products', product('Luxury Item', 28))).status === 422);

  section('7. Purchases take the supplier’s rate as billed');
  const sup = data<{ id: string }>(await owner.post('/suppliers', { name: 'Sharma Distributors', contactPerson: 'Anil Sharma', phone: '98311 22334', email: 'orders@sharma.test', gstin: '19ABCDE1234F1Z5', drugLicense: 'WB/KOL/20B/1189', creditDays: 30, address: 'Bagri Market, Kolkata' })).id;
  const pLine = (gstRate: number) => ({ productId: dolo, batchNumber: `DL${String(gstRate * 10)}`, expiry: '2028-08', quantity: 10, freeQuantity: 0, unit: 'STRIP', rate: 10_000, discountPercent: 0, mrp: 15_000, gstRate, rack: '' });
  const buy = (gstRate: number, inv: string) => owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: sup, invoiceNumber: inv, invoiceDate: isoDay(-2), lines: [pLine(gstRate)] });
  const pr = await buy(7.5, 'SD/1');
  const pd = pr.status === 201 ? data<{ cgst: number; sgst: number; grandTotal: number }>(await owner.get(`/purchases/${data<{ id: string }>(pr).id}`)) : { cgst: 0, sgst: 0, grandTotal: 0 };
  check('a 7.5% supplier line (not in the list) is fine → tax 75.00 on 1,000', pr.status === 201 && pd.cgst + pd.sgst === 7500 && pd.grandTotal === 107_500, `${code(pr)} ${JSON.stringify(pd)}`);
  check('101 % on a purchase → 422', (await buy(101, 'SD/2')).status === 422);

  section('8. Excel import checks the list');
  const rows = [{ name: 'Azithral 500', company: 'Alembic', saleUnit: 'STRIP', baseUnit: 'TABLET', pack: '5', category: 'Tablet', gst: '28', batch: 'AZ77', expiry: '2028-01', quantity: '20', mrp: '119.50', rate: '80' }];
  const dry = data<{ rows: { errors: string[] }[] }>(await owner.post('/products/import', { clientRequestId: randomUUID(), dryRun: true, rows }));
  check('GST 28 (removed) → row error naming the list', dry.rows[0]?.errors.some((e) => e.includes('not in your tax list (0, 3, 5, 12, 18)')) === true, JSON.stringify(dry.rows[0]?.errors));
  const ok = data<{ rows: { errors: string[] }[] }>(await owner.post('/products/import', { clientRequestId: randomUUID(), dryRun: true, rows: [{ ...rows[0], gst: '3' }] }));
  check('GST 3 → no error', ok.rows[0]?.errors.length === 0, JSON.stringify(ok.rows[0]?.errors));

  section('9. Every shop has its own list');
  const other = await h.signIn('kakoli@tax2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Kakoli Pharmacy'))).id;
  check('shop 2 still has the default list', data<Tax>(await other.get('/tax')).rates.length === 6);
  const oc = data<{ id: string; name: string }[]>(await other.get('/categories'));
  check('shop 2 can’t use shop 1’s 3% → 422', (await other.post('/products', { ...product('Gold Bhasma', 3), categoryId: oc.find((c) => c.name === 'Tablet')?.id })).status === 422);

  await h.close();
  finish();
}

main().catch(crash);
