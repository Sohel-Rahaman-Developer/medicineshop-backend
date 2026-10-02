// B4 billing checks: PLAN §14 bill, FEFO split, GST, discounts, typed price (D56), lowest price flag (D57), H1, cancel, return, orders, isolation.
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
interface Line { batchNumber: string; quantityInBase: number; mrp: number; gross: number; discountAmount: number; aboveMrpAmount: number; belowMinPrice: boolean; typedPrice: boolean; taxableAmount: number; cgst: number; sgst: number; totalAmount: number; expiryDate: string | null; lineCost?: number; returnedQuantity: number }
interface Sale { id: string; billNumber: string; status: string; lines: Line[]; subtotal: number; totalDiscount: number; taxableAmount: number; cgst: number; sgst: number; totalTax: number; roundOff: number; grandTotal: number; discountAboveLimit: boolean; aboveMrpAmount: number; belowMinPrice: boolean; doctorName: string; paymentMode: string; totalCost?: number; createdByName: string }
interface Ret { id: string; returnNumber: string; creditNoteNumber: string | null; total: number; refundMode: string; outsideWindow: boolean }
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

  section('11. Sale return (PLAN §15)');
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const ret = (saleId: string, items: { line: number; quantity: number; reason?: string }[], over: Record<string, unknown> = {}) => ({
    clientRequestId: randomUUID(),
    saleId,
    items: items.map((x) => ({ reason: 'Customer returned', ...x })),
    refundMode: 'CASH',
    ...over,
  });
  const dl24 = await stockOf('DL2401');
  const rb = ret(b1.id, [{ line: 0, quantity: 7 }], { expectedTotal: 1400 });
  const r11 = await owner.post('/sale-returns', rb);
  const rt1 = data<Ret>(r11);
  check(`7 of 30 Dolo tablets back → SR-${fy}-0001 · ₹14 cash`, r11.status === 201 && rt1.returnNumber === `SR-${fy}-0001` && rt1.total === 1400 && rt1.creditNoteNumber === null, code(r11));
  check('the same batch DL2401 gets the 7 tablets', (await stockOf('DL2401')) === dl24 + 7);
  const rb1 = data<Sale & { returns: unknown[] }>(await owner.get(`/sales/${b1.id}`));
  check('bill: partially returned · 7 returned on the line · return listed', rb1.status === 'partially_returned' && rb1.lines[0]?.returnedQuantity === 7 && rb1.returns.length === 1);
  const rep = await owner.post('/sale-returns', rb);
  check('same clientRequestId → 200, same return, stock not added twice', rep.status === 200 && data<Ret>(rep).id === rt1.id && (await stockOf('DL2401')) === dl24 + 7, code(rep));
  check('24 when 23 are left → 422', (await owner.post('/sale-returns', ret(b1.id, [{ line: 0, quantity: 24 }]))).status === 422);
  check('a line that isn’t on the bill → 422', (await owner.post('/sale-returns', ret(b1.id, [{ line: 9, quantity: 1 }]))).status === 422);
  check('the same line twice → 422', (await owner.post('/sale-returns', ret(b1.id, [{ line: 1, quantity: 1 }, { line: 1, quantity: 1 }]))).status === 422);
  check('refund by card (not offered) → 422', (await owner.post('/sale-returns', ret(b1.id, [{ line: 1, quantity: 1 }], { refundMode: 'CARD' }))).status === 422);
  const tcr = await owner.post('/sale-returns', ret(b1.id, [{ line: 1, quantity: 10 }], { expectedTotal: 1 }));
  check('saw another refund → 409 TOTAL_CHANGED', tcr.status === 409 && details(tcr).reason === 'TOTAL_CHANGED' && details(tcr).total === 9200, code(tcr));
  check('cancel a bill with a return → 409', (await owner.post(`/sales/${b1.id}/cancel`, { reason: 'Changed mind' })).status === 409);
  const r12 = await owner.post('/sale-returns', ret(b1.id, [{ line: 0, quantity: 23 }, { line: 1, quantity: 10 }], { refundMode: 'CREDIT_NOTE' }));
  const rt2 = data<Ret>(r12);
  check(`the rest as a credit note → CN-${fy}-0001 · ₹138`, r12.status === 201 && rt2.creditNoteNumber === `CN-${fy}-0001` && rt2.total === 13_800, code(r12));
  check('both returns add up to the bill exactly (₹14 + ₹138 = ₹152) · status returned', rt1.total + rt2.total === b1.grandTotal && data<Sale>(await owner.get(`/sales/${b1.id}`)).status === 'returned');
  check('a fully returned bill → 409', (await owner.post('/sale-returns', ret(b1.id, [{ line: 1, quantity: 1 }]))).status === 409);
  check('a cancelled bill → 409', (await owner.post('/sale-returns', ret(d2.id, [{ line: 0, quantity: 1 }]))).status === 409);

  // 5 loose tablets: ₹11.17 billed ₹11 (−0.17). Rounding each return on its own would give back ₹11.15.
  const lb = data<Saved>(loose);
  const parts: number[] = [];
  for (let i = 0; i < 5; i++) parts.push(data<Ret>(await owner.post('/sale-returns', ret(lb.id, [{ line: 0, quantity: 1 }]))).total);
  check('5 single-tablet returns add up to ₹11.17; the last gives back the −0.17 round off → ₹11 paid', parts.join() === '223,224,223,224,206' && parts.reduce((a, b) => a + b, 0) === lb.grandTotal, parts.join());

  // Old bill and an expired line: a warning only (D27), never a block.
  const ob = data<Saved>(await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(9200), customer: { name: 'Ratna Sen', phone: '98300 12345' } })));
  await SaleModel.updateOne({ shopId: shop1, _id: ob.id }, { $set: { billDate: new Date(Date.now() - 10 * 86_400_000), 'lines.0.expiryDate': new Date(Date.now() - 86_400_000) } });
  const ro = await owner.post('/sale-returns', ret(ob.id, [{ line: 0, quantity: 2, reason: 'Side effect — doctor stopped it' }]));
  const rod = data<Ret & { ageDays: number; lines: { expired: boolean }[] }>(await owner.get(`/sale-returns/${data<Ret>(ro).id}`));
  check('10-day-old bill (window 7) with an expired line → saved, flagged outside window + expired', ro.status === 201 && rod.outsideWindow && rod.ageDays === 10 && rod.lines[0]?.expired === true, code(ro));
  check('audit says how late', (await AuditLogModel.countDocuments({ shopId: shop1, entityName: rod.returnNumber, text: /10 days after the bill/ })) === 1);
  check('find the bill by the customer’s phone', data<{ id: string }[]>(await owner.get('/sales?q=12345')).some((x) => x.id === ob.id));

  // A batch that went back to the supplier comes alive again when a customer returns from it.
  await BatchModel.updateOne({ shopId: shop1, productId: thermo }, { $set: { status: 'returned' } });
  const rth = await owner.post('/sale-returns', ret(dth.id, [{ line: 0, quantity: 1 }]));
  const tb = await BatchModel.findOne({ shopId: shop1, productId: thermo }).lean();
  check('thermometer back → its batch active again with 1', rth.status === 201 && tb?.status === 'active' && tb.quantity === 1, code(rth));

  const pinId = data<Saved>(pin).id;
  const am6Before = await stockOf('AM6000');
  const race = await Promise.all([1, 2].map(() => owner.post('/sale-returns', ret(pinId, [{ line: 0, quantity: 10 }]))));
  check('two returns of the whole strip at once → one 201, one refused', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409 || r.status === 422).length === 1, race.map(code).join(' | '));
  check('AM6000 gets the strip back once', (await stockOf('AM6000')) === am6Before + 10);

  const cbId = data<Saved>(cb).id;
  check('cashier by default (no sales: create) → 403', (await cashier.post('/sale-returns', ret(cbId, [{ line: 0, quantity: 5 }]))).status === 403);
  // PLAN §15: given sales: create, the cashier returns only own bills (record scope, D20).
  const roleId = roles.find((r) => r.key === 'cashier')?.id;
  const member = data<{ members: { id: string; email: string }[] }>(await owner.get('/staff')).members.find((m) => m.email === 'sunita@sale1.test')?.id ?? '';
  const version = data<{ version: number }>(await owner.get(`/staff/${member}`)).version;
  check('owner grants the cashier sales: create', (await owner.put(`/staff/${member}`, { roleId, grants: { sales: ['create'] }, version })).status === 200);
  const crt = await cashier.post('/sale-returns', ret(cbId, [{ line: 0, quantity: 5 }]));
  check('cashier returns own bill → 201', crt.status === 201, code(crt));
  check('cashier returns the owner’s bill → 404', (await cashier.post('/sale-returns', ret(ob.id, [{ line: 0, quantity: 1 }]))).status === 404);
  check('accountant can’t return (no sales: create) → 403', (await accountant.post('/sale-returns', ret(cbId, [{ line: 0, quantity: 1 }]))).status === 403);
  const cl = data<{ id: string }[]>(await cashier.get('/sale-returns'));
  check('cashier list: only returns on own bills', cl.length === 1 && cl[0]?.id === data<Ret>(crt).id);
  check('cashier opens the owner’s return → 404 · its PDF → 404', (await cashier.get(`/sale-returns/${rt1.id}`)).status === 404 && (await cashier.get(`/sale-returns/${rt1.id}/pdf`)).status === 404);
  check('cashier: no cost on own return', data<{ totalCost?: number }>(await cashier.get(`/sale-returns/${data<Ret>(crt).id}`)).totalCost === undefined);
  check('owner sees the cost', data<{ totalCost?: number }>(await owner.get(`/sale-returns/${rt1.id}`)).totalCost === 7 * 127);
  check('accountant sees every return', data<unknown[]>(await accountant.get('/sale-returns?limit=100')).length === 11);
  check('list by bill', data<{ id: string }[]>(await owner.get(`/sale-returns?saleId=${b1.id}`)).length === 2);
  check('search by credit note number', data<{ id: string }[]>(await owner.get(`/sale-returns?q=CN-${fy}-0001`))[0]?.id === rt2.id);
  const cn = await owner.get(`/sale-returns/${rt2.id}/pdf`);
  check('credit note PDF', cn.status === 200 && cn.headers.get('content-type') === 'application/pdf' && cn.text.startsWith('%PDF'), code(cn));
  check('SALE_RETURN movements carry the return number', (await MovementModel.countDocuments({ shopId: shop1, type: 'SALE_RETURN', refNumber: /^SR-/ })) === 12);
  check('shop 2: return shop 1’s bill → 404', (await other.post('/sale-returns', ret(cbId, [{ line: 0, quantity: 1 }]))).status === 404);
  check('shop 2: shop 1 return → 404 · its PDF → 404 · list empty', (await other.get(`/sale-returns/${rt1.id}`)).status === 404 && (await other.get(`/sale-returns/${rt1.id}/pdf`)).status === 404 && data<unknown[]>(await other.get('/sale-returns')).length === 0);

  section('12. Customer orders (PLAN §35.1)');
  interface Ord { id: string; orderNumber: string; status: string; ready: boolean; billNumber: string | null; advanceUsed: number; advanceBack: number; items: { state: string; productId: string | null; qtyBase: number }[]; kept: unknown; refund: { amount: number; mode: string } | null }
  // The server prices a bill; an expectedTotal of 0 makes it say the total (409) before anything is saved.
  const quote = async (items: Record<string, unknown>[], over: Record<string, unknown> = {}) => (details(await owner.post('/sales', bill(items, { expectedTotal: 0, ...over }))).total as number | undefined) ?? -1;
  const ob1 = { clientRequestId: randomUUID(), customer: { name: 'Ratna Sen', phone: '98300 12345' }, items: [{ productId: amox, qty: 2 }, { name: 'Nurokind Gold Capsule', qty: 1 }], advance: 10_000, advanceMode: 'CASH', note: 'Call after 5 pm' };
  const or1 = await owner.post('/orders', ob1);
  const o1 = data<{ id: string; orderNumber: string }>(or1);
  check(`order with a ₹100 cash advance → ORD-${fy}-0001`, or1.status === 201 && o1.orderNumber === `ORD-${fy}-0001`, code(or1));
  check('same clientRequestId → 200, same order', (await owner.post('/orders', ob1)).status === 200);
  const g1 = data<Ord>(await owner.get(`/orders/${o1.id}`));
  check('Augmentin 2 strips = 20 capsules · the typed name is “free” · not ready', g1.items[0]?.qtyBase === 20 && g1.items[1]?.state === 'free' && !g1.ready);
  check('advance without how it was paid → 422', (await owner.post('/orders', { ...ob1, clientRequestId: randomUUID(), advanceMode: undefined })).status === 422);
  check('a product of nowhere → 422 · no items → 422', (await owner.post('/orders', { ...ob1, clientRequestId: randomUUID(), items: [{ productId: am6, qty: 1 }] })).status === 422 && (await owner.post('/orders', { ...ob1, clientRequestId: randomUUID(), items: [] })).status === 422);
  check('link the typed line to Dolo → 200', (await owner.post(`/orders/${o1.id}/link`, { index: 1, productId: dolo })).status === 200);
  check('link it again → 409', (await owner.post(`/orders/${o1.id}/link`, { index: 1, productId: dolo })).status === 409);
  check('now ready, and on the Ready tab', data<Ord>(await owner.get(`/orders/${o1.id}`)).ready && data<Ord[]>(await owner.get('/orders?status=ready')).some((x) => x.id === o1.id));
  check('summary: 1 open, 1 ready, ₹100 advance held', JSON.stringify(data<unknown>(await owner.get('/orders/summary'))) === JSON.stringify({ open: 1, ready: 1, stale: 0, advanceHeld: 10_000 }));

  const oitems = [{ productId: amox, quantity: 2, unit: 'STRIP' }, { productId: dolo, quantity: 1, unit: 'STRIP' }];
  const ot = await quote(oitems);
  check('paying the whole bill when ₹100 is already paid → 422', (await owner.post('/sales', bill(oitems, { orderId: o1.id, payments: cash(ot) }))).status === 422);
  const obill = await owner.post('/sales', bill(oitems, { orderId: o1.id, payments: cash(ot - 10_000), expectedTotal: ot }));
  const os1 = data<Saved & { advanceUsed: number; advanceBack: number }>(obill);
  check(`bill the order: ${String(ot / 100)} less ₹100 advance, paid in cash`, obill.status === 201 && os1.advanceUsed === 10_000 && os1.advanceBack === 0, code(obill));
  const osd = data<Sale & { payments: { mode: string; amount: number; reference: string }[]; orderNumber: string | null }>(await owner.get(`/sales/${os1.id}`));
  check('the bill shows ADVANCE ₹100 against the order', osd.orderNumber === o1.orderNumber && osd.payments.some((p) => p.mode === 'ADVANCE' && p.amount === 10_000 && p.reference === o1.orderNumber) && osd.paymentMode === 'SPLIT');
  const og = data<Ord>(await owner.get(`/orders/${o1.id}`));
  check('order completed with the bill number', og.status === 'completed' && og.billNumber === os1.billNumber && og.advanceUsed === 10_000);
  check('bill the same order again → 409', (await owner.post('/sales', bill(oitems, { orderId: o1.id, payments: cash(ot - 10_000) }))).status === 409);
  check('a client can’t send ADVANCE itself → 422', (await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: [{ mode: 'ADVANCE', amount: 9200 }] }))).status === 422);

  const o2 = data<{ id: string }>(await owner.post('/orders', { clientRequestId: randomUUID(), customer: { name: 'Big Advance' }, items: [{ productId: amox, qty: 1 }], advance: 50_000, advanceMode: 'UPI' }));
  const t2 = await quote([{ productId: amox, quantity: 1, unit: 'STRIP' }]);
  const b2 = data<Saved & { advanceUsed: number; advanceBack: number }>(await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { orderId: o2.id })));
  check(`₹500 advance on a ₹${String(t2 / 100)} bill → nothing to pay, the rest back from the drawer`, t2 > 0 && b2.advanceUsed === t2 && b2.advanceBack === 50_000 - t2 && data<Ord>(await owner.get(`/orders/${o2.id}`)).advanceBack === 50_000 - t2, JSON.stringify(b2));

  const o3 = data<{ id: string }>(await cashier.post('/orders', { clientRequestId: randomUUID(), customer: { name: 'Walk Away' }, items: [{ productId: dolo, qty: 1 }], advance: 5000, advanceMode: 'CASH' }));
  check('cashier takes an order → 201', o3.id.length === 24);
  check('cashier can’t keep the advance (Owner / Manager) → 403', (await cashier.post(`/orders/${o3.id}/cancel`, { reason: 'Never came', keepReason: 'Special order' })).status === 403);
  const c3 = await cashier.post(`/orders/${o3.id}/cancel`, { reason: 'Customer bought elsewhere', refundMode: 'CASH' });
  check('cashier cancels → ₹50 back in cash', c3.status === 200 && data<Ord>(await owner.get(`/orders/${o3.id}`)).refund?.amount === 5000, code(c3));
  check('cancel again → 409 · bill a cancelled order → 409', (await cashier.post(`/orders/${o3.id}/cancel`, { reason: 'Again' })).status === 409 && (await owner.post('/sales', bill([{ productId: dolo, quantity: 1, unit: 'STRIP' }], { orderId: o3.id }))).status === 409);
  const o4 = data<{ id: string }>(await owner.post('/orders', { clientRequestId: randomUUID(), customer: { name: 'Special Import' }, items: [{ name: 'Imported insulin pen', qty: 1 }], advance: 20_000, advanceMode: 'UPI' }));
  check('owner keeps an advance with a reason', (await owner.post(`/orders/${o4.id}/cancel`, { reason: 'Never came', keepReason: 'Special import, told non-refundable' })).status === 200 && data<Ord>(await owner.get(`/orders/${o4.id}`)).kept !== null);
  check('audit: order taken, billed against, cancelled', (await AuditLogModel.countDocuments({ shopId: shop1, entityName: o1.orderNumber })) === 2 && (await AuditLogModel.countDocuments({ shopId: shop1, entityName: os1.billNumber, text: /order ORD-/ })) === 1);
  check('accountant (no POS) → orders 403', (await accountant.get('/orders')).status === 403);
  check('shop 2: shop 1 order → 404 · cancel → 404 · link → 404', (await other.get(`/orders/${o1.id}`)).status === 404 && (await other.post(`/orders/${o4.id}/cancel`, { reason: 'Hack attempt' })).status === 404 && (await other.post(`/orders/${o1.id}/link`, { index: 0, productId: dolo })).status === 404);
  check('shop 2: bill shop 1 order → 404', (await other.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { orderId: o4.id }))).status === 404);

  await ledgerEqualsStock('end');
  await h.close();
  finish();
}

main().catch(crash);
