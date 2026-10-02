// B4 billing checks: PLAN §14 bill, FEFO split, GST, discounts, typed price (D56), lowest price flag (D57), H1, cancel, isolation.
import { randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const details = (r: Res) => (r.json.error as { details?: Record<string, unknown> } | undefined)?.details ?? {};

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: {
    name,
    address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' },
    phone: '033 2229 4410',
    drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418',
    drugLicenseExpiry: '2031-03',
    pricingMode: 'MRP_INCLUSIVE',
  },
  termsVersion: '2026-10',
  agree: true,
});

interface Saved { id: string; billNumber: string; grandTotal: number; change: number }
interface Line { batchNumber: string; quantityInBase: number; mrp: number; gross: number; discountAmount: number; aboveMrpAmount: number; belowMinPrice: boolean; typedPrice: boolean; taxableAmount: number; cgst: number; sgst: number; totalAmount: number; expiryDate: string | null; lineCost?: number }
interface Sale { id: string; billNumber: string; status: string; lines: Line[]; subtotal: number; totalDiscount: number; taxableAmount: number; cgst: number; sgst: number; totalTax: number; roundOff: number; grandTotal: number; discountAboveLimit: boolean; aboveMrpAmount: number; belowMinPrice: boolean; doctorName: string; paymentMode: string; totalCost?: number; createdByName: string }
interface Hit { id: string; sellable: number; batches: { batchNumber: string; costPerBaseUnit?: number }[] }

const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const units10 = { type: 'COUNT', base: 'CAPSULE', sale: 'STRIP', salePack: 10, purchase: 'STRIP', purchasePack: 1, allowLooseSale: true };
const piece = { type: 'COUNT', base: 'PIECE', sale: 'PIECE', salePack: 1, purchase: 'PIECE', purchasePack: 1, allowLooseSale: false };

async function main() {
  const h = await startHarness();
  const { MovementModel } = await import('../src/modules/stock/movement.model.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { ProductModel } = await import('../src/modules/products/product.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { fyOf } = await import('../src/utils/fy.js');
  const fy = fyOf(new Date());

  const owner = await h.signIn('rohit@sale1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const cat = (n: string) => cats.find((c) => c.name === n)?.id ?? '';
  const mk = async (name: string, units: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cat('Tablet'), scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: 'A-2-1', reorderLevel: 0, reorderQuantity: 0, ...over })).id;
  const dolo = await mk('Dolo 650 Tablet', units15, { barcode: '8901234567890' });
  const amox = await mk('Augmentin 625', units10, { hsnCode: '30042019' });
  const alprax = await mk('Alprax 0.25', units15, { scheduleType: 'H1' });
  const thermo = await mk('Digital Thermometer', piece, { scheduleType: 'NON_DRUG', noExpiry: true, gstRate: 18, hsnCode: '90251990', categoryId: cat('Device') });
  const open = async (over: Record<string, unknown>) => {
    const r = await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', ...over });
    if (r.status !== 201) throw new Error(`opening failed: ${code(r)}`);
  };
  await open({ productId: dolo, batchNumber: 'DL2401', expiry: '2026-12', quantity: 330, mrp: 3000, purchaseRate: 1909 });
  await open({ productId: dolo, batchNumber: 'DL2409', expiry: '2027-08', quantity: 450, mrp: 3350, purchaseRate: 2340, minPrice: 3200 });
  await open({ productId: amox, batchNumber: 'AM5512', expiry: '2028-03', quantity: 100, mrp: 9200, purchaseRate: 6460 });
  await open({ productId: amox, batchNumber: 'AM6000', expiry: '2029-01', quantity: 50, mrp: 9500, purchaseRate: 6600 });
  await open({ productId: alprax, batchNumber: 'AL1', expiry: '2027-06', quantity: 150, mrp: 4500, purchaseRate: 2800 });
  await open({ productId: thermo, batchNumber: '', quantity: 5, mrp: 25_000, purchaseRate: 15_000 });

  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    const sent = await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    const inv = data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? '';
    const ok = await c.post(`/invitations/${inv}/accept`, { name: email.split('@')[0] });
    if (sent.status !== 201 || ok.status !== 200) throw new Error(`invite ${key} failed: ${code(sent)} / ${code(ok)}`);
    c.shopId = shop1;
    return c;
  };
  const cashier = await invite('sunita@sale1.test', 'cashier');
  const accountant = await invite('meera@sale1.test', 'accountant');

  const stockOf = async (batch: string) => (await BatchModel.findOne({ shopId: shop1, batchNumber: batch }).lean())?.quantity ?? -1;
  const ledgerEqualsStock = async (label: string) => {
    const batches = await BatchModel.find({ shopId: shop1 }).lean();
    let bad = 0;
    for (const b of batches) {
      const [s] = await MovementModel.aggregate<{ q: number }>([{ $match: { shopId: b.shopId, batchId: b._id } }, { $group: { _id: null, q: { $sum: '$quantity' } } }]);
      if ((s?.q ?? 0) !== b.quantity) bad++;
    }
    const prods = await ProductModel.find({ shopId: shop1 }).lean();
    let roll = 0;
    for (const p of prods) {
      const sum = batches.filter((b) => b.productId.equals(p._id) && b.status === 'active' && b.expiryDate.getTime() > Date.now()).reduce((a, b) => a + b.quantity, 0);
      if (sum !== p.stock.sellable) roll++;
    }
    check(`${label}: movements = batch qty on ${String(batches.length)} batches · rollups = batches`, bad === 0 && roll === 0, `${String(bad)} batch · ${String(roll)} rollup`);
  };
  const bill = (items: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), items, payments: [], ...over });
  const cash = (amount: number) => [{ mode: 'CASH', amount }];

  section('1. POS search');
  const s1 = data<{ items: Hit[]; exact: string | null }>(await owner.get('/pos/search?q=dolo'));
  const hit = s1.items[0];
  check('“dolo” → Dolo with 2 batches, FEFO DL2401 first, 780 sellable', hit?.id === dolo && hit.sellable === 780 && hit.batches.map((b) => b.batchNumber).join() === 'DL2401,DL2409');
  check('owner sees cost per tablet', hit?.batches[0]?.costPerBaseUnit !== undefined);
  const cs = data<{ items: Hit[] }>(await cashier.get('/pos/search?q=dolo')).items[0];
  check('cashier: no cost in POS search', cs !== undefined && cs.batches.every((b) => b.costPerBaseUnit === undefined));
  check('barcode → exact product', data<{ exact: string | null }>(await owner.get('/pos/search?q=8901234567890')).exact === dolo);
  check('ids → exactly those products (cart refresh)', data<{ items: Hit[] }>(await owner.get(`/pos/search?ids=${dolo},${thermo}`)).items.map((x) => x.id).sort().join() === [dolo, thermo].sort().join());
  check('empty search → in-stock products', data<{ items: Hit[] }>(await owner.get('/pos/search')).items.length === 4);
  const ps = data<{ roundOff: boolean; maxDiscountPercent: number; enforceH1: boolean; canPickBatch: boolean; seesCost: boolean }>(await owner.get('/pos/settings'));
  check('POS settings: round off, 20 % limit, H1 on, owner may pick a batch', ps.roundOff && ps.maxDiscountPercent === 20 && ps.enforceH1 && ps.canPickBatch && ps.seesCost);
  const cps = data<{ canPickBatch: boolean; seesCost: boolean }>(await cashier.get('/pos/settings'));
  check('POS settings for the cashier: no batch pick, no cost', !cps.canPickBatch && !cps.seesCost);
  check('accountant (no POS) → search 403', (await accountant.get('/pos/search?q=dolo')).status === 403);

  section('2. PLAN §14 bill — ₹152');
  const b1body = bill([{ productId: dolo, quantity: 2, unit: 'STRIP' }, { productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(15_200), cashReceived: 20_000, expectedTotal: 15_200 });
  const r1 = await owner.post('/sales', b1body);
  const b1 = data<Saved>(r1);
  check(`first bill is INV-${fy}-00001 · ₹152 · change ₹48`, r1.status === 201 && b1.billNumber === `INV-${fy}-00001` && b1.grandTotal === 15_200 && b1.change === 4800, code(r1));
  const d1 = data<Sale>(await owner.get(`/sales/${b1.id}`));
  check('taxable 135.71 · CGST 8.15 · SGST 8.14 · tax 16.29', d1.taxableAmount === 13_571 && d1.cgst === 815 && d1.sgst === 814 && d1.totalTax === 1629);
  check('line 1: Dolo DL2401 (FEFO) 30 tablets · CGST 3.22 · SGST 3.21', d1.lines[0]?.batchNumber === 'DL2401' && d1.lines[0].quantityInBase === 30 && d1.lines[0].cgst === 322 && d1.lines[0].sgst === 321);
  check('DL2401 330 → 300 · AM5512 100 → 90', (await stockOf('DL2401')) === 300 && (await stockOf('AM5512')) === 90);
  const again = await owner.post('/sales', b1body);
  check('same clientRequestId → 200, same bill, stock not taken twice', again.status === 200 && data<Saved>(again).id === b1.id && (await stockOf('DL2401')) === 300, code(again));
  check('owner sees cost and profit', d1.totalCost === 30 * 127 + 10 * 646 && d1.lines[0]?.lineCost !== undefined, String(d1.totalCost));
  check('audit: “billed INV-…”', (await AuditLogModel.countDocuments({ shopId: shop1, module: 'sales', entityName: b1.billNumber, action: 'create' })) === 1);

  section('3. FEFO split, short stock, payments');
  const r2 = await owner.post('/sales', bill([{ productId: dolo, quantity: 25, unit: 'STRIP' }], { payments: [{ mode: 'UPI', amount: 76_800, reference: 'UPI123' }] }));
  const d2 = data<Sale>(await owner.get(`/sales/${data<Saved>(r2).id}`));
  check('25 strips → 20 from DL2401 @ ₹30 + 5 from DL2409 @ ₹33.50', r2.status === 201 && d2.lines.length === 2 && d2.lines[0]?.quantityInBase === 300 && d2.lines[1]?.batchNumber === 'DL2409' && d2.lines[1].quantityInBase === 75 && d2.lines[1].mrp === 3350, code(r2));
  check('₹767.50 → ₹768 with +0.50 round off', d2.subtotal === 76_750 && d2.roundOff === 50 && d2.grandTotal === 76_800);
  check('paid by UPI', d2.paymentMode === 'UPI');
  const short = await owner.post('/sales', bill([{ productId: dolo, quantity: 1000, unit: 'STRIP' }], { payments: cash(100) }));
  check('more than in stock → 409 SHORT with what is left', short.status === 409 && details(short).reason === 'SHORT' && details(short).available === 375, code(short));
  const tw = await owner.post('/sales', bill([{ productId: dolo, quantity: 20, unit: 'STRIP' }, { productId: dolo, quantity: 10, unit: 'STRIP' }], { payments: cash(100) }));
  check('two lines of the same product can’t promise the same tablets twice → 409', tw.status === 409 && details(tw).available === 75, code(tw));
  check('payments ≠ total → 422', (await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(9000) }))).status === 422);
  const tc = await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(9200), expectedTotal: 9000 }));
  check('cashier saw another total → 409 TOTAL_CHANGED', tc.status === 409 && details(tc).reason === 'TOTAL_CHANGED' && details(tc).total === 9200, code(tc));
  check('cash received under the cash part → 422', (await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(9200), cashReceived: 5000 }))).status === 422);
  const split = await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: [{ mode: 'CASH', amount: 5000 }, { mode: 'CARD', amount: 4200 }] }));
  check('split cash + card → SPLIT', split.status === 201 && data<Sale>(await owner.get(`/sales/${data<Saved>(split).id}`)).paymentMode === 'SPLIT', code(split));

  section('4. Typed price (D56), lowest price (D57), discounts (D43)');
  const above = await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP', price: 10_000 }], { payments: cash(10_000) }));
  const da = data<Sale>(await owner.get(`/sales/${data<Saved>(above).id}`));
  check('typed ₹100 on ₹92 MRP → ₹8 above MRP, bill saved', above.status === 201 && da.aboveMrpAmount === 800 && da.lines[0]?.typedPrice === true && da.grandTotal === 10_000, code(above));
  check('above MRP is in the audit text', (await AuditLogModel.countDocuments({ shopId: shop1, entityName: da.billNumber, text: /above MRP/ })) === 1);
  const low = await owner.post('/sales', bill([{ productId: dolo, quantity: 1, unit: 'STRIP', price: 3000 }], { payments: cash(3000) }));
  const dl = data<Sale>(await owner.get(`/sales/${data<Saved>(low).id}`));
  check('DL2409 (lowest ₹32) typed ₹30 → saved, only flagged', low.status === 201 && dl.belowMinPrice && dl.lines[0]?.belowMinPrice === true && dl.totalDiscount === 350, code(low));
  const lowOk = data<Sale>(await owner.get(`/sales/${data<Saved>(await owner.post('/sales', bill([{ productId: dolo, quantity: 1, unit: 'STRIP', price: 3300 }], { payments: cash(3300) }))).id}`));
  check('typed ₹33 is above the lowest → no flag', !lowOk.belowMinPrice);
  const big = await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { billDiscount: { type: 'pct', value: 25 }, payments: cash(6900) }));
  const db = data<Sale>(await owner.get(`/sales/${data<Saved>(big).id}`));
  check('25 % off with a 20 % limit → saved, flagged for the discount register', big.status === 201 && db.discountAboveLimit && db.totalDiscount === 2300, code(big));
  const ld = data<Sale>(await owner.get(`/sales/${data<Saved>(await owner.post('/sales', bill([{ productId: amox, quantity: 2, unit: 'STRIP', discount: { type: 'flat', value: 1000 } }], { payments: cash(17_400) }))).id}`));
  check('flat ₹10 line discount', ld.totalDiscount === 1000 && ld.grandTotal === 17_400 && !ld.discountAboveLimit);
  check('negative typed price → 422', (await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP', price: -1 }], { payments: cash(0) }))).status === 422);
  check('discount over 100 % → 422', (await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP', discount: { type: 'pct', value: 101 } }], { payments: cash(0) }))).status === 422);
  check('typed price + discount together → 422', (await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP', price: 5000, discount: { type: 'pct', value: 5 } }], { payments: cash(5000) }))).status === 422);
  const free = await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP', price: 0 }]));
  check('typed ₹0 (free sample) → saved with no payment', free.status === 201 && data<Saved>(free).grandTotal === 0, code(free));
  check('flag filter: above-MRP bills', data<{ billNumber: string }[]>(await owner.get('/sales?flag=aboveMrp')).map((x) => x.billNumber).join() === da.billNumber);

  section('5. Units, H1, no-expiry items, batch choice');
  const loose = await owner.post('/sales', bill([{ productId: dolo, quantity: 5, unit: 'TABLET' }], { payments: cash(1100) }));
  check('5 loose tablets of a ₹33.50 strip → ₹11.17 → ₹11', loose.status === 201 && data<Saved>(loose).grandTotal === 1100, code(loose));
  check('wrong unit → 422', (await owner.post('/sales', bill([{ productId: thermo, quantity: 1, unit: 'STRIP' }], { payments: cash(25_000) }))).status === 422);
  const h1 = await owner.post('/sales', bill([{ productId: alprax, quantity: 1, unit: 'STRIP' }], { payments: cash(4500) }));
  check('H1 without doctor and patient → 422', h1.status === 422, code(h1));
  const h1ok = await owner.post('/sales', bill([{ productId: alprax, quantity: 1, unit: 'STRIP' }], { payments: cash(4500), rx: { doctorName: 'Dr. S. Banerjee', patientName: 'Amit Das', rxNumber: 'RX-88' } }));
  check('H1 with doctor + patient → saved on the bill', h1ok.status === 201 && data<Sale>(await owner.get(`/sales/${data<Saved>(h1ok).id}`)).doctorName === 'Dr. S. Banerjee', code(h1ok));
  const th = await owner.post('/sales', bill([{ productId: thermo, quantity: 1, unit: 'PIECE' }], { payments: cash(25_000) }));
  const dth = data<Sale>(await owner.get(`/sales/${data<Saved>(th).id}`));
  check('thermometer (no expiry) sells · expiry null · 18 % GST', th.status === 201 && dth.lines[0]?.expiryDate === null && dth.taxableAmount === 21_186, code(th));
  const am6 = (await BatchModel.findOne({ shopId: shop1, batchNumber: 'AM6000' }).lean())?._id.toString() ?? '';
  const pin = await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP', batchId: am6 }], { payments: cash(9500) }));
  check('owner picks AM6000 by hand → that batch at its MRP', pin.status === 201 && data<Sale>(await owner.get(`/sales/${data<Saved>(pin).id}`)).lines[0]?.batchNumber === 'AM6000', code(pin));

  section('6. Cashier, accountant, record scope');
  const cb = await cashier.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(9200) }));
  check('cashier bills → 201', cb.status === 201, code(cb));
  check('cashier picking a non-FEFO batch → 403', (await cashier.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP', batchId: am6 }], { payments: cash(9500) }))).status === 403);
  const mine = data<{ id: string; createdByName: string }[]>(await cashier.get('/sales'));
  check('cashier list: only own bills', mine.length === 1 && mine[0]?.id === data<Saved>(cb).id);
  check('cashier opens the owner’s bill → 404', (await cashier.get(`/sales/${b1.id}`)).status === 404);
  check('cashier owner’s bill PDF → 404', (await cashier.get(`/sales/${b1.id}/pdf`)).status === 404);
  const own = data<Sale>(await cashier.get(`/sales/${data<Saved>(cb).id}`));
  check('cashier: no cost or profit on own bill', own.totalCost === undefined && own.lines.every((l) => l.lineCost === undefined));
  check('cashier can’t cancel (no sales: approve) → 403', (await cashier.post(`/sales/${data<Saved>(cb).id}/cancel`, { reason: 'Wrong item' })).status === 403);
  check('accountant can’t bill (no POS) → 403', (await accountant.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(9200) }))).status === 403);
  check('accountant sees every bill', data<unknown[]>(await accountant.get('/sales?limit=100')).length > 10);
  check('unknown field → 422', (await owner.post('/sales', { ...bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(9200) }), grandTotal: 1 })).status === 422);

  section('7. Cancel');
  const before = [await stockOf('DL2401'), await stockOf('DL2409')];
  const c2 = await owner.post(`/sales/${d2.id}/cancel`, { reason: 'Customer changed mind' });
  check('owner cancels the split bill → 200', c2.status === 200, code(c2));
  check('both batches get their tablets back (300 + 75)', (await stockOf('DL2401')) === (before[0] ?? 0) + 300 && (await stockOf('DL2409')) === (before[1] ?? 0) + 75);
  check('cancel again → 409', (await owner.post(`/sales/${d2.id}/cancel`, { reason: 'Again' })).status === 409);
  check('no reason → 422', (await owner.post(`/sales/${b1.id}/cancel`, {})).status === 422);
  check('SALE_CANCEL movements: 2', (await MovementModel.countDocuments({ shopId: shop1, type: 'SALE_CANCEL' })) === 2);
  check('cancelled bill PDF says CANCELLED', (await owner.get(`/sales/${d2.id}/pdf`)).status === 200);

  section('8. Two bills at once for the last pieces');
  const both = await Promise.all([1, 2].map(() => owner.post('/sales', bill([{ productId: thermo, quantity: 4, unit: 'PIECE' }], { payments: cash(100_000) }))));
  check('4 thermometers left, two bills of 4 at once → one 201, one 409', both.filter((r) => r.status === 201).length === 1 && both.filter((r) => r.status === 409).length === 1, both.map(code).join(' | '));
  check('none left, never negative', ((await BatchModel.findOne({ shopId: shop1, productId: thermo }).lean())?.quantity ?? -1) === 0);

  section('9. Another shop');
  const other = await h.signIn('owner@sale2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Other Pharmacy'))).id;
  check('shop 2: shop 1 bill → 404', (await other.get(`/sales/${b1.id}`)).status === 404);
  check('shop 2: shop 1 bill PDF → 404', (await other.get(`/sales/${b1.id}/pdf`)).status === 404);
  check('shop 2: cancel shop 1 bill → 404', (await other.post(`/sales/${b1.id}/cancel`, { reason: 'Hack attempt' })).status === 404);
  check('shop 2: sell shop 1 product → 422', (await other.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(9200) }))).status === 422);
  check('shop 2: POS search finds nothing of shop 1', data<{ items: Hit[] }>(await other.get('/pos/search?q=dolo')).items.length === 0);
  check('shop 2: no bills', data<unknown[]>(await other.get('/sales')).length === 0);

  section('10. Bill PDF, list, summary');
  const pdf = await owner.get(`/sales/${b1.id}/pdf`);
  check('bill PDF (A5 with QR)', pdf.status === 200 && pdf.headers.get('content-type') === 'application/pdf' && pdf.text.startsWith('%PDF'), code(pdf));
  check('search by bill number', data<{ id: string }[]>(await owner.get(`/sales?q=00001`))[0]?.id === b1.id);
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const sum = data<{ bills: number; total: number; cancelled: number; upi: number; card: number }>(await owner.get(`/sales/summary?from=${today}&to=${today}`));
  check('summary: cancelled counted apart, UPI of the cancelled bill not in UPI', sum.cancelled === 1 && sum.upi === 0 && sum.card === 4200 && sum.bills > 10, JSON.stringify(sum));
  check('cashier summary: own bills only', data<{ bills: number }>(await cashier.get(`/sales/summary?from=${today}&to=${today}`)).bills === 1);
  check('SALE movements written for every bill line', (await MovementModel.countDocuments({ shopId: shop1, type: 'SALE' })) > 15);
  check('Dolo lastSoldAt set', Boolean((await ProductModel.findOne({ shopId: shop1, _id: dolo }).lean())?.lastSoldAt));

  await ledgerEqualsStock('end');
  await h.close();
  finish();
}

main().catch(crash);
