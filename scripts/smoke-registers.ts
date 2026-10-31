// Registers checks: sales, stock and purchases of any medicine, filtered every way — never cost — and their files.
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
const units10 = { type: 'COUNT', base: 'CAPSULE', sale: 'STRIP', salePack: 10, purchase: 'STRIP', purchasePack: 1, allowLooseSale: true };
const IST = 5.5 * 3600_000;
const isoDay = (offsetDays = 0) => new Date(Date.now() + IST + offsetDays * 86_400_000).toISOString().slice(0, 10);

interface Reg { key: string; name: string; cols: { key: string }[]; rows: Record<string, string | number | null>[]; count: number; summary: { schedule: string; lines: number; docs: number }[] }

async function main() {
  const h = await startHarness();
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');

  const owner = await h.signIn('rohit@reg1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Register Test Pharmacy'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const ok = async (what: string, p: Promise<Res>) => {
    const r = await p;
    if (r.status !== 200 && r.status !== 201) throw new Error(`${what}: ${code(r)}`);
    return r;
  };
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const cat = (n: string) => cats.find((x) => x.name === n)?.id;
  const mk = async (name: string, units: Record<string, unknown>, scheduleType: string, category: string) =>
    data<{ id: string }>(await ok(`product ${name}`, owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cat(category), scheduleType, storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 }))).id;
  const dolo = await mk('Dolo 650 Tablet', units15, 'OTC', 'Tablet');
  const pan = await mk('Pan 40 Tablet', units15, 'H', 'Tablet');
  const amox = await mk('Augmentin 625', units10, 'H1', 'Capsule');
  const alprax = await mk('Alprax 0.25 Tablet', units15, 'H1', 'Tablet');
  for (const [id, b, mrp] of [[dolo, 'DL1', 3000], [pan, 'PN1', 3350], [amox, 'AM1', 9200], [alprax, 'AX1', 4500]] as const) {
    await ok('stock', owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A-1', productId: id, batchNumber: b, expiry: '2028-12', quantity: 150, mrp, purchaseRate: Math.round(mrp * 0.65) }));
  }
  const ratna = data<{ id: string }>(await ok('customer', owner.post('/customers', { name: 'Ratna Sen', phone: '98300 12345' })));
  const bill = (items: Record<string, unknown>[], payments: Record<string, unknown>[], over: Record<string, unknown> = {}) => ok('bill', owner.post('/sales', { clientRequestId: randomUUID(), items, payments, ...over }));
  const rx = { doctorName: 'Dr. S. Banerjee', patientName: 'Amit Das', rxNumber: 'RX-88' };
  type Saved = { id: string; billNumber: string };

  section('1. Bills, a purchase and the stock');
  const a = data<Saved>(await bill([{ productId: dolo, quantity: 2, unit: 'STRIP' }, { productId: amox, quantity: 1, unit: 'STRIP' }], [{ mode: 'CASH', amount: 15_200 }], { customerId: ratna.id, rx }));
  const b = data<Saved>(await bill([{ productId: alprax, quantity: 1, unit: 'STRIP' }, { productId: pan, quantity: 1, unit: 'STRIP' }], [{ mode: 'UPI', amount: 7900 }], { rx: { ...rx, doctorName: 'Dr. P. Roy', rxNumber: 'RX-91' } }));
  await bill([{ productId: dolo, quantity: 1, unit: 'STRIP' }], [{ mode: 'CASH', amount: 3000 }]);
  const x = data<Saved>(await bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], [{ mode: 'CASH', amount: 9200 }], { rx }));
  await ok('cancel', owner.post(`/sales/${x.id}/cancel`, { reason: 'Wrong item' }));
  await ok('return', owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: a.id, items: [{ line: 1, quantity: 3, reason: 'Bought extra' }], refundMode: 'CASH' }));
  const sup = data<{ id: string }>(await ok('supplier', owner.post('/suppliers', { name: 'Sharma Distributors', contactPerson: '', phone: '98311 22334', email: '', gstin: '19ABCDE1234F1Z5', drugLicense: '', creditDays: 30, address: '' }))).id;
  await ok('purchase', owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: sup, invoiceNumber: 'SD/26/9', invoiceDate: isoDay(), lines: [{ productId: alprax, batchNumber: 'AX9', expiry: '2028-06', quantity: 10, freeQuantity: 1, unit: 'STRIP', rate: 2900, discountPercent: 0, mrp: 4500, gstRate: 12, rack: '' }, { productId: dolo, batchNumber: 'DL9', expiry: '2028-06', quantity: 5, freeQuantity: 0, unit: 'STRIP', rate: 1900, discountPercent: 0, mrp: 3000, gstRate: 12, rack: '' }] }));
  await BatchModel.updateOne({ shopId: shop1, batchNumber: 'PN1' }, { $set: { expiryDate: new Date(Date.now() - 86_400_000) } });
  const range = `from=${isoDay(-1)}&to=${isoDay()}`;
  const reg = async (kind: string, q = '') => data<Reg>(await ok(`${kind} ${q}`, owner.get(`/reports/registers/${kind}?${kind === 'stock' ? '' : `${range}&`}${q}`)));

  section('2. Sales register');
  const all = await reg('sales');
  check('every line of the live bills (the cancelled one left out): 5 lines', all.count === 5 && !all.rows.some((r) => r.bill === x.billNumber), String(all.count));
  check('no cost or profit column, ever', !all.cols.some((col) => /cost|profit|rate|margin/i.test(col.key)), all.cols.map((col) => col.key).join());
  const h1 = await reg('sales', 'schedule=H1');
  check('Schedule H1 → Augmentin + Alprax, with patient, doctor, Rx no., batch, expiry', h1.count === 2 && h1.rows.every((r) => r.schedule === 'H1' && r.patient === 'Amit Das' && typeof r.rx === 'string' && r.rx.startsWith('RX-') && r.expiry === '12/2028'), JSON.stringify(h1.rows));
  check('the returned part shows on its line', h1.rows.some((r) => r.drug === 'Augmentin 625' && /3 CAPSULE returned/.test(String(r.qty))), JSON.stringify(h1.rows.map((r) => r.qty)));
  check('summary by schedule: H1 2 lines on 2 bills', h1.summary.length === 1 && h1.summary[0]?.schedule === 'H1' && h1.summary[0].lines === 2 && h1.summary[0].docs === 2, JSON.stringify(h1.summary));
  const many = await reg('sales', 'schedule=H,H1');
  check('two schedules at once: H + H1 → 3 lines', many.count === 3 && many.summary.length === 2);
  check('two categories at once: Tablet + Capsule → 5 · Capsule only → 1', (await reg('sales', 'category=Tablet,Capsule')).count === 5 && (await reg('sales', 'category=Capsule')).count === 1);
  check('medicine name “alpr” → Alprax only', (await reg('sales', 'q=alpr')).rows.map((r) => r.drug).join() === 'Alprax 0.25 Tablet');
  check('customer by phone digits → Ratna’s bill only', (await reg('sales', 'party=12345')).rows.every((r) => r.bill === a.billNumber));
  check('doctor “roy” → bill B', (await reg('sales', 'doctor=roy')).rows.every((r) => r.bill === b.billNumber) && (await reg('sales', 'doctor=roy')).count === 2);
  check('paid by UPI → bill B', (await reg('sales', 'pay=UPI')).rows.every((r) => r.bill === b.billNumber));
  check('each bill’s own amount ₹50–₹100 → bill B (₹79) only', (await reg('sales', 'min=5000&max=10000')).rows.every((r) => r.bill === b.billNumber), JSON.stringify((await reg('sales', 'min=5000&max=10000')).rows.map((r) => r.bill)));
  check('a bad schedule → 422 · min above max → 422 · no dates → 422', (await owner.get(`/reports/registers/sales?${range}&schedule=Z`)).status === 422 && (await owner.get(`/reports/registers/sales?${range}&min=500&max=100`)).status === 422 && (await owner.get('/reports/registers/sales')).status === 422);

  section('3. Stock and purchase registers');
  const st = await reg('stock', 'schedule=H1');
  check('H1 stock: Augmentin AM1 + Alprax AX1 and the bought AX9 with its supplier and invoice', st.count === 3 && st.rows.some((r) => r.batch === 'AX9' && r.supplier === 'Sharma Distributors' && r.invoice === 'SD/26/9') && st.rows.some((r) => r.batch === 'AM1' && r.supplier === 'Opening stock'), JSON.stringify(st.rows));
  check('stock quantity in packs: Alprax AX9 = 11 STRIP (10 + 1 free)', st.rows.some((r) => r.batch === 'AX9' && r.qty === '11 STRIP'), JSON.stringify(st.rows.map((r) => r.qty)));
  check('expired only → Pan 40 PN1', (await reg('stock', 'expiry=expired')).rows.map((r) => r.batch).join() === 'PN1');
  check('stock by supplier “sharma” → AX9 + DL9', (await reg('stock', 'party=sharma')).count === 2);
  const pr = await reg('purchases', 'schedule=H1');
  check('H1 purchases: Alprax 10 STRIP + 1 free from Sharma, GSTIN shown, no rate', pr.count === 1 && pr.rows[0]?.qty === '10 STRIP' && pr.rows[0].free === '1 STRIP' && pr.rows[0].gstin === '19ABCDE1234F1Z5' && !pr.cols.some((col) => col.key === 'rate'), JSON.stringify(pr.rows));

  section('4. Files, and who may');
  const xl = await owner.get(`/reports/registers/sales/export?${range}&schedule=H1&format=xlsx`);
  check('Excel named for what was chosen (Schedule H1)', xl.status === 200 && /Sales-register.*Schedule-H1/.test(xl.headers.get('content-disposition') ?? ''), `${code(xl)} ${xl.headers.get('content-disposition') ?? ''}`);
  const pdf = await owner.get(`/reports/registers/stock/export?schedule=H1&format=pdf`);
  check('stock PDF', pdf.status === 200 && pdf.text.startsWith('%PDF'), code(pdf));
  const roles = data<{ id: string; key: string }[]>(await owner.get('/roles'));
  await ok('invite', owner.post('/staff', { email: 'sunita@reg1.test', name: 'sunita', roleId: roles.find((r) => r.key === 'cashier')?.id }));
  const cashier = await h.signIn('sunita@reg1.test');
  const inv = data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? '';
  await ok('accept', cashier.post(`/invitations/${inv}/accept`, { name: 'sunita' }));
  cashier.shopId = shop1;
  check('cashier (no reports) → 403', (await cashier.get(`/reports/registers/sales?${range}`)).status === 403);
  const other = await h.signIn('amit@reg2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Other Pharmacy'))).id;
  check('another shop sees none of these', data<Reg>(await other.get(`/reports/registers/sales?${range}`)).count === 0 && data<Reg>(await other.get('/reports/registers/stock')).count === 0);

  finish();
}

main().catch(crash);
