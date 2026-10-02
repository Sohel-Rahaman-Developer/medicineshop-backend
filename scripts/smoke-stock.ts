// B2 product + stock checks: PLAN §9 worked example, merge rule, ledger = stock, adjustments, isolation, photo, import.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const meta = (r: Res) => (r.json as { meta?: { nextCursor: string | null; hasMore: boolean } }).meta;

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

interface Category { id: string; name: string; isSystem: boolean; products: number }
interface Stock { sellable: number; expired: number; blocked: number; onHand: number; status: string; value?: number; mrpValue: number; nextExpiry: string | null }
interface Product { id: string; name: string; version: number; stock: Stock; photo: string | null; units: { salePack: number }; defaultRack: string }
interface Batch { id: string; batchNumber: string; quantity: number; bucket: string; sellsNext: boolean; mrp: number; rack: string; costPerBaseUnit?: number; purchaseRate?: number }

const units = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };

async function main() {
  const h = await startHarness();
  const { MovementModel } = await import('../src/modules/stock/movement.model.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { ProductModel } = await import('../src/modules/products/product.model.js');
  const { monthEndIST } = await import('../src/utils/date.js');

  const owner = await h.signIn('rohit@stock1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;

  section('1. Categories');
  const cats = data<Category[]>(await owner.get('/categories'));
  check('11 built-in categories on a new shop', cats.length === 11 && cats.every((c) => c.isSystem));
  const tablet = cats.find((c) => c.name === 'Tablet')?.id ?? '';
  const eye = await owner.post('/categories', { name: 'Eye drops' });
  check('add “Eye drops” → 201', eye.status === 201, code(eye));
  const clash = await owner.post('/categories', { name: ' EYE-DROP ' });
  check('“EYE-DROP” clashes with “Eye drops” → 409', clash.status === 409 && clash.json.error?.message?.includes('Eye drops') === true, code(clash));
  check('built-in category can’t be removed → 403', (await owner.del(`/categories/${tablet}`)).status === 403);

  const product = (over: Record<string, unknown> = {}) => ({
    name: 'Dolo 650 Tablet', company: 'Micro Labs', salt: 'Paracetamol', strength: '650 mg', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL',
    hsnCode: '30049099', gstRate: 12, barcode: '8901234567890', units, packSize: '', defaultRack: 'a-2-1', reorderLevel: 300, reorderQuantity: 450, ...over,
  });

  section('2. Product master + units');
  const bad = await owner.post('/products', product({ units: { ...units, sale: 'TABLET' } }));
  check('sale = base with pack 15 → 422', bad.status === 422, code(bad));
  check('GST 7% → 422', (await owner.post('/products', product({ gstRate: 7 }))).status === 422);
  check('unknown field → 422', (await owner.post('/products', product({ shopId: shop1 }))).status === 422);
  check('VOLUME type with TABLET → 422', (await owner.post('/products', product({ units: { ...units, type: 'VOLUME' } }))).status === 422);
  const made = await owner.post('/products', product());
  check('Dolo created → 201', made.status === 201, code(made));
  const dolo = data<{ id: string }>(made).id;
  const dup = await owner.post('/products', product({ name: 'DOLO 650 tablet', barcode: '' }));
  check('same name, other case → 422 on name', dup.status === 422 && JSON.stringify(dup.json).includes('body.name'), code(dup));
  const dupCode = await owner.post('/products', product({ name: 'Crocin 650' }));
  check('same barcode → 422 on barcode', dupCode.status === 422 && JSON.stringify(dupCode.json).includes('body.barcode'), code(dupCode));
  const racks = data<{ code: string; storageType: string }[]>(await owner.get('/racks'));
  check('default rack upper-cased and added to the rack master', racks.some((r) => r.code === 'A-2-1'));
  const p0 = data<Product>(await owner.get(`/products/${dolo}`));
  check('new product: out of stock, no photo', p0.stock.status === 'out' && p0.photo === null && p0.units.salePack === 15);

  section('3. Photo (SECURITY §6 B2)');
  const jpegWithGps = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#d33' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-gps-28.61N' } })
    .toBuffer();
  const asUrl = (type: string, b: Buffer) => `data:${type};base64,${b.toString('base64')}`;
  const v0 = p0.version;
  const withPhoto = await owner.put(`/products/${dolo}`, { ...product(), photo: asUrl('image/jpeg', jpegWithGps), version: v0 });
  check('JPEG photo accepted', withPhoto.status === 200, code(withPhoto));
  const stored = await ProductModel.findOne({ shopId: shop1, _id: dolo }).lean();
  const buf = Buffer.from((stored?.photo?.data as unknown as { buffer: Uint8Array }).buffer);
  const pm = await sharp(buf).metadata();
  check('stored as 96 × 96 WebP', pm.format === 'webp' && pm.width === 96 && pm.height === 96, `${pm.format} ${String(pm.width)}`);
  check('at most 3 KB', buf.length <= 3072, String(buf.length));
  check('EXIF / GPS text stripped', !buf.includes('secret-gps') && !pm.exif);
  const p1 = data<Product>(await owner.get(`/products/${dolo}`));
  check('API returns it as a WebP data URL', p1.photo?.startsWith('data:image/webp;base64,') === true);
  const liar = await owner.put(`/products/${dolo}`, { ...product(), photo: asUrl('image/png', jpegWithGps), version: p1.version });
  check('PNG label on JPEG bytes → 422', liar.status === 422, code(liar));
  check('not an image → 422', (await owner.put(`/products/${dolo}`, { ...product(), photo: asUrl('image/png', Buffer.from('<svg onload=alert(1)>')), version: p1.version })).status === 422);
  check('SVG type → 422', (await owner.put(`/products/${dolo}`, { ...product(), photo: asUrl('image/svg+xml', Buffer.from('<svg/>')), version: p1.version })).status === 422);
  const huge = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
  check('3000 × 3000 pixels → 422 (decompression bomb guard)', (await owner.put(`/products/${dolo}`, { ...product(), photo: asUrl('image/png', huge), version: p1.version })).status === 422, String(huge.length));
  check('over 90 KB body → 422', (await owner.put(`/products/${dolo}`, { ...product(), photo: `data:image/png;base64,${'A'.repeat(95_000)}`, version: p1.version })).status === 422);
  check('a rejected photo leaves the product as it was', data<Product>(await owner.get(`/products/${dolo}`)).version === p1.version);

  section('4. Opening stock — PLAN §9 worked example');
  const opening = (over: Record<string, unknown>) => ({ clientRequestId: randomUUID(), productId: dolo, batchNumber: 'DL2401', expiry: '2026-12', quantity: 330, mrp: 3000, purchaseRate: 1909, rack: '', ...over });
  const o1 = await owner.post('/stock/opening', opening({}));
  check('DL2401: 22 STRIP at ₹30 → 201 new', o1.status === 201 && data<{ how: string }>(o1).how === 'new', code(o1));
  const o2body = opening({ batchNumber: 'DL2409', expiry: '2027-08', quantity: 450, mrp: 3350, purchaseRate: 2340 });
  const o2 = await owner.post('/stock/opening', o2body);
  check('DL2409: 30 STRIP at ₹33.50 → 201 new', o2.status === 201, code(o2));
  const o2again = await owner.post('/stock/opening', o2body);
  check('same clientRequestId again → 200 with the same batch', o2again.status === 200 && data<{ batchId: string }>(o2again).batchId === data<{ batchId: string }>(o2).batchId, code(o2again));
  const p2 = data<Product>(await owner.get(`/products/${dolo}`));
  check('total 780 TABLET = 52 STRIP', p2.stock.sellable === 780 && p2.stock.sellable / 15 === 52, String(p2.stock.sellable));
  check('MRP value ₹660 + ₹1,005', p2.stock.mrpValue === 66000 + 100500, String(p2.stock.mrpValue));
  check('status ok (780 > 300 reorder level)', p2.stock.status === 'ok');
  let batches = data<Batch[]>(await owner.get(`/products/${dolo}/batches`));
  check('FEFO: DL2401 first and marked “sells next”', batches[0]?.batchNumber === 'DL2401' && batches[0].sellsNext && batches[1]?.sellsNext === false);
  check('landing cost per tablet = ₹19.09 / 15 rounded', batches[0]?.costPerBaseUnit === 127, String(batches[0]?.costPerBaseUnit));
  check('batch took the product’s default rack', batches[0]?.rack === 'A-2-1');

  const merge = await owner.post('/stock/opening', opening({ batchNumber: 'dl2409', expiry: '2027-08', quantity: 15, mrp: 3350, purchaseRate: 2340 }));
  check('same batch + expiry + MRP (any case) → merged into DL2409', merge.status === 201 && data<{ how: string; batchNumber: string }>(merge).how === 'merged' && data<{ batchNumber: string }>(merge).batchNumber === 'DL2409', code(merge));
  const mrpBody = opening({ batchNumber: 'DL2409', expiry: '2027-08', quantity: 15, mrp: 3500, purchaseRate: 2340 });
  const mrpDiff = await owner.post('/stock/opening', mrpBody);
  const details = (mrpDiff.json.error as { details?: { reason?: string } } | undefined)?.details;
  check('same batch, other MRP → 409 MRP_DIFFERS', mrpDiff.status === 409 && details?.reason === 'MRP_DIFFERS', code(mrpDiff));
  const sep = await owner.post('/stock/opening', { ...mrpBody, mrpChoice: 'separate' });
  check('“separate” → new batch DL2409-A', sep.status === 201 && data<{ batchNumber: string }>(sep).batchNumber === 'DL2409-A', code(sep));

  section('5. Validation of quantities and prices');
  const v = async (over: Record<string, unknown>) => (await owner.post('/stock/opening', opening(over))).status;
  check('negative quantity → 422', (await v({ quantity: -5 })) === 422);
  check('zero quantity → 422', (await v({ quantity: 0 })) === 422);
  check('1 billion → 422', (await v({ quantity: 1_000_000_000 })) === 422);
  check('fractional quantity → 422', (await v({ quantity: 1.5 })) === 422);
  check('MRP in rupees with decimals → 422 (paise only)', (await v({ mrp: 30.5 })) === 422);
  check('MRP 0 → 422', (await v({ mrp: 0 })) === 422);
  check('month 13 → 422', (await v({ expiry: '2026-13' })) === 422);
  check('made after expiry → 422', (await v({ mfg: '2027-01' })) === 422);
  check('quantity as a string → 422', (await v({ quantity: '10' })) === 422);

  section('6. Concurrency + idempotency');
  const raceBody = opening({ batchNumber: 'RACE1', quantity: 10 });
  const [r1, r2] = await Promise.all([owner.post('/stock/opening', raceBody), owner.post('/stock/opening', raceBody)]);
  const raceBatch = await BatchModel.findOne({ shopId: shop1, batchNumber: 'RACE1' }).lean();
  check('two identical requests at once → stock added once', raceBatch?.quantity === 10 && [r1.status, r2.status].every((s) => s === 200 || s === 201), `${String(raceBatch?.quantity)} ${String(r1.status)} ${String(r2.status)}`);

  section('7. Adjustments');
  const dl2401 = batches.find((b) => b.batchNumber === 'DL2401');
  const count = await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'PHYSICAL_COUNT', reason: 'Monthly rack count', lines: [{ batchId: dl2401?.id, expected: 330, counted: 325 }] });
  check('count 325 of 330 → ADJ-2026-27-0001', count.status === 201 && data<{ adjustmentNumber: string }>(count).adjustmentNumber === 'ADJ-2026-27-0001', code(count));
  const stale = await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'PHYSICAL_COUNT', reason: 'Recount', lines: [{ batchId: dl2401?.id, expected: 330, counted: 330 }] });
  check('count against a quantity that changed → 409 “count it again”', stale.status === 409 && /again/.test(stale.json.error?.message ?? ''), code(stale));
  const dmgBody = { clientRequestId: randomUUID(), type: 'DAMAGE', reason: 'Strip torn', lines: [{ batchId: dl2401?.id, quantity: 3 }] };
  const dmg = await owner.post('/stock/adjustments', dmgBody);
  check('damage 3 → 201, ADJ-…-0002', dmg.status === 201 && data<{ adjustmentNumber: string }>(dmg).adjustmentNumber.endsWith('0002'), code(dmg));
  const dmgAgain = await owner.post('/stock/adjustments', dmgBody);
  check('same damage request again → same number, stock not taken twice', dmgAgain.status === 200 && data<{ adjustmentNumber: string }>(dmgAgain).adjustmentNumber.endsWith('0002'));
  const tooMuch = await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'SELF_USE', reason: 'Shop use', lines: [{ batchId: dl2401?.id, quantity: 100000 }] });
  check('more than on hand → 409', tooMuch.status === 409, code(tooMuch));
  check('no reason → 422', (await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'DAMAGE', reason: '', lines: [{ batchId: dl2401?.id, quantity: 1 }] })).status === 422);
  check('same batch twice in one adjustment → 422', (await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'DAMAGE', reason: 'x2', lines: [{ batchId: dl2401?.id, quantity: 1 }, { batchId: dl2401?.id, quantity: 1 }] })).status === 422);
  const dl = await BatchModel.findOne({ shopId: shop1, _id: dl2401?.id }).lean();
  check('DL2401 now 322 (330 − 5 − 3)', dl?.quantity === 322, String(dl?.quantity));

  await owner.post('/racks', { code: 'F-1', name: 'Fridge', storageType: 'COLD' });
  const dl2409 = batches.find((b) => b.batchNumber === 'DL2409');
  const move = await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'TRANSFER', reason: 'Fridge space', lines: [{ batchId: dl2409?.id, rackTo: 'F-1' }] });
  check('rack transfer → 201', move.status === 201, code(move));
  check('to an unknown rack → 422', (await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'TRANSFER', reason: 'x', lines: [{ batchId: dl2409?.id, rackTo: 'ZZ-9' }] })).status === 422);
  check('to the rack it is already on → 422', (await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'TRANSFER', reason: 'x', lines: [{ batchId: dl2409?.id, rackTo: 'F-1' }] })).status === 422);
  const moved = await MovementModel.findOne({ shopId: shop1, type: 'RACK_MOVE' }).lean();
  check('RACK_MOVE movement with from → to and qty 0', moved?.rackFrom === 'A-2-1' && moved.rackTo === 'F-1' && moved.quantity === 0);

  const last = data<{ batchId: string }>(await owner.post('/stock/opening', opening({ batchNumber: 'LAST5', quantity: 5 }))).batchId;
  const take = () => owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'DAMAGE', reason: 'Race', lines: [{ batchId: last, quantity: 5 }] });
  const race = await Promise.all([take(), take(), take()]);
  const lastBatch = await BatchModel.findOne({ shopId: shop1, _id: last }).lean();
  check('three people take the last 5 at once → exactly one wins', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 2, race.map((r) => r.status).join(','));
  check('…and the batch is 0, never negative', lastBatch?.quantity === 0, String(lastBatch?.quantity));

  const { applyMove } = await import('../src/modules/stock/stock.ledger.js');
  const { inTransaction } = await import('../src/core/transaction.js');
  const { Types } = await import('mongoose');
  const actor = { id: new Types.ObjectId().toString(), name: 'Ledger test', email: 'x@test.local' };
  let refused = '';
  try {
    await inTransaction((session) => applyMove(new Types.ObjectId(shop1), new Types.ObjectId(last), -1, { type: 'DAMAGE', refType: 'TEST', actor, at: new Date() }, session));
  } catch (err) {
    refused = (err as { code?: string }).code ?? 'other';
  }
  check('the ledger itself refuses to take stock that is not there (empty batch, −1)', refused === 'CONFLICT', refused);
  check('…and writes no movement for it', (await MovementModel.countDocuments({ shopId: shop1, refType: 'TEST' })) === 0);

  section('8. Ledger = stock (BUILD §9)');
  const all = await BatchModel.find({ shopId: shop1 }).lean();
  let ledgerOk = true;
  let chainOk = true;
  for (const b of all) {
    const ms = await MovementModel.find({ shopId: shop1, batchId: b._id }).sort({ at: 1, _id: 1 }).lean();
    if (ms.reduce((s, m) => s + m.quantity, 0) !== b.quantity) ledgerOk = false;
    let bal = 0;
    for (const m of ms) {
      if (m.balanceBefore !== bal || m.balanceAfter !== bal + m.quantity) chainOk = false;
      bal = m.balanceAfter;
    }
  }
  check(`every batch (${String(all.length)}): sum of movements = quantity`, ledgerOk);
  check('balance before → after chains with no gap', chainOk);
  const why = data<{ ledgerTotal: number; batch: { quantity: number }; byType: { type: string; quantity: number }[] }>(await owner.get(`/stock/batches/${dl2401?.id ?? ''}/why`));
  check('“why did stock change?” adds up to the batch', why.ledgerTotal === why.batch.quantity && why.byType.some((g) => g.type === 'OPENING' && g.quantity === 330));
  const p3 = await ProductModel.findOne({ shopId: shop1, _id: dolo }).lean();
  const sellable = all.filter((b) => String(b.productId) === dolo && b.status === 'active' && b.expiryDate > new Date()).reduce((s, b) => s + b.quantity, 0);
  check('product rollup = its batches', p3?.stock.sellable === sellable, `${String(p3?.stock.sellable)} vs ${String(sellable)}`);

  const picked = data<{ batchNumber: string; quantity: number }[]>(await owner.get(`/stock/batches?ids=${dl2401?.id ?? ''},${dl2409?.id ?? ''}`));
  check('batches by id for an adjustment', picked.length === 2 && picked.some((b) => b.batchNumber === 'DL2401' && b.quantity === 322));
  check('bad id in the list → 422', (await owner.get('/stock/batches?ids=xyz')).status === 422);

  section('9. Block / unblock');
  check('block without a reason → 422', (await owner.post(`/stock/batches/${dl2401?.id ?? ''}/block`, {})).status === 422);
  const blk = await owner.post(`/stock/batches/${dl2401?.id ?? ''}/block`, { reason: 'Supplier recall notice' });
  check('block → 200', blk.status === 200, code(blk));
  const p4 = data<Product>(await owner.get(`/products/${dolo}`));
  check('blocked stock leaves sellable', p4.stock.blocked === 322 && p4.stock.sellable === (p3?.stock.sellable ?? 0) - 322, JSON.stringify(p4.stock));
  batches = data<Batch[]>(await owner.get(`/products/${dolo}/batches`));
  check('“sells next” moves to the next Dec 2026 batch (RACE1), not the blocked one', batches.find((b) => b.sellsNext)?.batchNumber === 'RACE1', batches.find((b) => b.sellsNext)?.batchNumber);
  await owner.post(`/stock/batches/${dl2401?.id ?? ''}/unblock`, {});
  check('unblock → sellable again', data<Product>(await owner.get(`/products/${dolo}`)).stock.blocked === 0);

  section('10. Expiry centre + stale rollup');
  const syrup = data<{ id: string }>(
    await owner.post('/products', product({ name: 'Benadryl Syrup 100ml', salt: 'Diphenhydramine', barcode: '', categoryId: cats.find((c) => c.name === 'Syrup')?.id, units: { type: 'COUNT', base: 'BOTTLE', sale: 'BOTTLE', salePack: 1, purchase: 'BOX', purchasePack: 24, allowLooseSale: false }, reorderLevel: 5, reorderQuantity: 24, defaultRack: 'C-2-1' })),
  ).id;
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), productId: syrup, batchNumber: 'BD8812', expiry: '2026-08', quantity: 9, mrp: 14300, purchaseRate: 10100, rack: '' });
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), productId: syrup, batchNumber: 'BD9001', expiry: '2026-10', quantity: 4, mrp: 14300, purchaseRate: 10100, rack: '' });
  const ex = data<{ summary: { bucket: string; count: number; value?: number }[]; items: { batchNumber: string; daysLeft: number }[] }>(await owner.get('/stock/expiry?bucket=expired'));
  check('expired batch shows in the Expired tab', ex.items.some((i) => i.batchNumber === 'BD8812'));
  check('Oct 2026 batch is in 0–30 days', ex.summary.find((s) => s.bucket === 'd30')?.count === 1);
  const sy = data<Product>(await owner.get(`/products/${syrup}`));
  check('syrup: 4 sellable, 9 expired → low', sy.stock.sellable === 4 && sy.stock.expired === 9 && sy.stock.status === 'low', JSON.stringify(sy.stock));
  // Month end passes: the Oct batch expires; the stored rollup must not keep calling it sellable.
  await BatchModel.updateOne({ shopId: shop1, batchNumber: 'BD9001' }, { $set: { expiryDate: monthEndIST(2026, 9) } });
  await ProductModel.updateOne({ shopId: shop1, _id: syrup }, { $set: { 'stock.validUntil': monthEndIST(2026, 9) } });
  const listAfter = data<{ id: string; stock: Stock }[]>(await owner.get('/products?q=benadryl'));
  check('after the month passes the list recomputes: 0 sellable, out', listAfter[0]?.stock.sellable === 0 && listAfter[0].stock.status === 'out', JSON.stringify(listAfter[0]?.stock));

  section('11. Product list — server search, filters, cursor');
  await owner.post('/products', product({ name: 'Pan 40 Tablet', salt: 'Pantoprazole', strength: '40 mg', company: 'Alkem', barcode: '8906000000040', reorderLevel: 0 }));
  await owner.post('/products', product({ name: 'Crocin Advance', salt: 'Paracetamol', strength: '650 mg', company: 'GSK', barcode: '8906000000650' }));
  const ids = (r: Res) => data<{ name: string }[]>(r).map((x) => x.name);
  check('“dolo” → Dolo', ids(await owner.get('/products?q=dolo')).join() === 'Dolo 650 Tablet');
  check('salt “para” → Crocin + Dolo', ids(await owner.get('/products?q=para')).join() === 'Crocin Advance,Dolo 650 Tablet');
  check('two words “650 micro” → Dolo', ids(await owner.get('/products?q=650%20micro')).join() === 'Dolo 650 Tablet');
  check('exact barcode → Pan 40', ids(await owner.get('/products?q=8906000000040')).join() === 'Pan 40 Tablet');
  check('regex characters are dropped, never run as a pattern', ids(await owner.get('/products?q=.*')).length === ids(await owner.get('/products')).length && ids(await owner.get('/products?q=d.l.o')).length === 0);
  check('status=out → Pan 40, Crocin, Benadryl', ids(await owner.get('/products?status=out')).join() === 'Benadryl Syrup 100ml,Crocin Advance,Pan 40 Tablet');
  check('rack=F-1 → Dolo', ids(await owner.get('/products?rack=F-1')).join() === 'Dolo 650 Tablet');
  const pageA = await owner.get('/products?limit=2');
  const pageB = await owner.get(`/products?limit=2&cursor=${meta(pageA)?.nextCursor ?? ''}`);
  check('cursor pages: 2 + 2, no repeats, then the end', ids(pageA).length === 2 && meta(pageA)?.hasMore === true && ids(pageB).length === 2 && meta(pageB)?.hasMore === false && !ids(pageB).some((n) => ids(pageA).includes(n)));
  check('broken cursor → 400', (await owner.get('/products?cursor=not-a-cursor')).status === 400);
  check('limit 500 → 422', (await owner.get('/products?limit=500')).status === 422);
  const sum = data<{ products: number; out: number; inStock: number; value?: number }>(await owner.get('/products/summary'));
  check('summary tiles', sum.products === 4 && sum.out === 3 && sum.inStock === 1 && typeof sum.value === 'number', JSON.stringify(sum));

  section('12. Edit rules');
  const pe = data<Product>(await owner.get(`/products/${dolo}`));
  const lock = await owner.put(`/products/${dolo}`, { ...product(), units: { ...units, salePack: 10 }, version: pe.version });
  check('pack size can’t change once stock exists → 409', lock.status === 409, code(lock));
  const okEdit = await owner.put(`/products/${dolo}`, { ...product(), units: { ...units, purchasePack: 12 }, reorderLevel: 1000, version: pe.version });
  check('purchase pack + reorder level can change', okEdit.status === 200, code(okEdit));
  check('reorder level change re-rates the status', data<Product>(await owner.get(`/products/${dolo}`)).stock.status === 'low');
  check('stale version → 409', (await owner.put(`/products/${dolo}`, { ...product(), version: pe.version })).status === 409);
  const reorder = data<{ name: string; suggestion: { saleUnits: number; basis: string } }[]>(await owner.get('/stock/reorder'));
  check('reorder list has Dolo with a suggestion from the reorder quantity', reorder.some((r) => r.name === 'Dolo 650 Tablet' && r.suggestion.basis === 'reorderQty'));

  section('13. Cashier and stock keeper');
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    const inv = data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? '';
    await c.post(`/invitations/${inv}/accept`, { name: email.split('@')[0] });
    c.shopId = shop1;
    return c;
  };
  const cashier = await invite('sunita@stock1.test', 'cashier');
  const keeper = await invite('kamal@stock1.test', 'stockKeeper');
  const cp = data<Product>(await cashier.get(`/products/${dolo}`));
  check('cashier sees the product but no stock value', cp.name === 'Dolo 650 Tablet' && cp.stock.value === undefined);
  const cb = data<Batch[]>(await cashier.get(`/products/${dolo}/batches`));
  check('cashier: batches without rate or landing cost', cb.length > 0 && cb.every((b) => b.costPerBaseUnit === undefined && b.purchaseRate === undefined));
  check('cashier: summary without value', data<{ value?: number }>(await cashier.get('/products/summary')).value === undefined);
  check('cashier: expiry tiles without cost', data<{ summary: { value?: number }[] }>(await cashier.get('/stock/expiry')).summary.every((s) => s.value === undefined));
  check('cashier: adjustment list without value', data<{ totalValue?: number }[]>(await cashier.get('/stock/adjustments')).every((a) => a.totalValue === undefined));
  check('cashier: sort by value falls back to name', (await cashier.get('/products?sort=value')).status === 200);
  check('cashier → add product 403', (await cashier.post('/products', product({ name: 'X' }))).status === 403);
  check('cashier → opening stock 403', (await cashier.post('/stock/opening', opening({ batchNumber: 'X1' }))).status === 403);
  check('cashier → adjustment 403', (await cashier.post('/stock/adjustments', dmgBody)).status === 403);
  check('cashier → add category 403', (await cashier.post('/categories', { name: 'Baby care' })).status === 403);
  check('stock keeper sees cost (reports: view)', data<Batch[]>(await keeper.get(`/products/${dolo}/batches`)).every((b) => typeof b.costPerBaseUnit === 'number'));
  const wo = await keeper.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'EXPIRY_WRITE_OFF', reason: 'Expired', lines: [{ batchId: ex.items[0]?.batchNumber === 'BD8812' ? (await BatchModel.findOne({ shopId: shop1, batchNumber: 'BD8812' }).lean())?._id.toString() : '', quantity: 9 }] });
  check('stock keeper write-off → 403 (needs stock: approve)', wo.status === 403, code(wo));
  const bd = await BatchModel.findOne({ shopId: shop1, batchNumber: 'BD8812' }).lean();
  const woOwner = await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'EXPIRY_WRITE_OFF', reason: 'Expired — writing off', lines: [{ batchId: String(bd?._id), quantity: 9 }] });
  check('owner write-off → 201, approved by the owner', woOwner.status === 201, code(woOwner));
  const adjs = await owner.get('/stock/adjustments?limit=2');
  check('adjustments list: newest first, cursor', data<{ type: string; approvedBy: string | null }[]>(adjs)[0]?.approvedBy === 'Rohit Agarwal' && meta(adjs)?.hasMore === true);

  section('14. Another shop can’t touch any of it');
  const other: Client = await h.signIn('sourav@stock2.test');
  const shop2 = data<{ id: string }>(await other.post('/shops', shopBody('Life Care Pharmacy'))).id;
  other.shopId = shop2;
  const rack1 = data<{ id: string; code: string }[]>(await owner.get('/racks')).find((r) => r.code === 'F-1')?.id ?? '';
  check('product of shop 1 → 404', (await other.get(`/products/${dolo}`)).status === 404);
  check('its batches → 404', (await other.get(`/products/${dolo}/batches`)).status === 404);
  check('edit it → 404', (await other.put(`/products/${dolo}`, { ...product({ categoryId: data<Category[]>(await other.get('/categories'))[0]?.id }), version: 0 })).status === 404);
  check('opening stock into it → 404', (await other.post('/stock/opening', opening({ batchNumber: 'EVIL' }))).status === 404);
  check('block its batch → 404', (await other.post(`/stock/batches/${dl2401?.id ?? ''}/block`, { reason: 'x' })).status === 404);
  check('adjust its batch → 404', (await other.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'DAMAGE', reason: 'evil', lines: [{ batchId: dl2401?.id, quantity: 1 }] })).status === 404);
  check('its batches by id → empty list', data<unknown[]>(await other.get(`/stock/batches?ids=${dl2401?.id ?? ''}`)).length === 0);
  check('its batch history → 404', (await other.get(`/stock/batches/${dl2401?.id ?? ''}/why`)).status === 404);
  check('rename its rack → 404', (await other.put(`/racks/${rack1}`, { code: 'X-1', name: '', storageType: 'NORMAL' })).status === 404);
  check('remove its category → 404', (await other.del(`/categories/${eye.json.data ? (eye.json.data as { id: string }).id : ''}`)).status === 404);
  check('shop 1 category on a shop 2 product → 422', (await other.post('/products', product({ name: 'Foreign', barcode: '' }))).status === 422);
  check('shop 2 sees an empty product list', data<unknown[]>(await other.get('/products')).length === 0);
  check('shop 2 movements are empty', data<unknown[]>(await other.get('/stock/movements')).length === 0);
  check('the same rack code is fine in another shop', (await other.post('/racks', { code: 'F-1', name: '', storageType: 'COLD' })).status === 201);

  section('15. Racks');
  const a21 = data<{ id: string; code: string; products: number }[]>(await owner.get('/racks')).find((r) => r.code === 'A-2-1');
  const ren = await owner.put(`/racks/${a21?.id ?? ''}`, { code: 'A-2-9', name: 'Almirah A', storageType: 'NORMAL' });
  check('rename A-2-1 → A-2-9', ren.status === 200, code(ren));
  check('batches moved with it', (await BatchModel.countDocuments({ shopId: shop1, rack: 'A-2-1' })) === 0 && (await BatchModel.countDocuments({ shopId: shop1, rack: 'A-2-9' })) > 0);
  check('default racks moved with it', (await ProductModel.countDocuments({ shopId: shop1, defaultRack: 'A-2-1' })) === 0);
  const find = data<{ name: string; places: { rack: string }[] }[]>(await owner.get('/racks/find?q=dolo'));
  check('“Where is dolo?” → its racks', find[0]?.name === 'Dolo 650 Tablet' && find[0].places.some((p) => p.rack === 'F-1'));
  check('rename onto an existing code → 422', (await owner.put(`/racks/${a21?.id ?? ''}`, { code: 'F-1', name: '', storageType: 'NORMAL' })).status === 422);

  section('16. Excel import');
  const rows = [
    { name: 'Dolo 650 Tablet', batch: 'DL2501', expiry: '03/28', quantity: '10', mrp: '30.00', rate: '21.00', rack: 'A-2-9' },
    { name: 'Azithral 500', company: 'Alembic', saleUnit: 'STRIP', baseUnit: 'TABLET', pack: '5', category: 'Tablet', gst: '12', batch: 'AZ77', expiry: '2028-01', quantity: '20', mrp: '119.50', rate: '80' },
    { name: 'Cotton roll', batch: 'CR1', expiry: '12/2029', quantity: '7', mrp: '45', rate: '30' },
    { name: 'Bad row', batch: '', expiry: '13/26', quantity: '-1', mrp: 'abc', rate: '1' },
  ];
  const dry = await owner.post('/products/import', { clientRequestId: randomUUID(), dryRun: true, rows });
  const dr = data<{ rows: { row: number; product: string; errors: string[]; warnings: string[] }[]; summary: { errors: number; newProducts: number } }>(dry);
  check('dry run → per-row result', dry.status === 200 && dr.rows.length === 4, code(dry));
  check('row 4 has its errors listed', (dr.rows[3]?.errors.length ?? 0) >= 4, JSON.stringify(dr.rows[3]?.errors));
  check('existing vs new products detected', dr.rows[0]?.product === 'existing' && dr.rows[1]?.product === 'new' && dr.summary.newProducts === 3);
  check('no units given → PIECE warning', dr.rows[2]?.warnings.some((w) => w.includes('PIECE')) === true);
  check('nothing written by a dry run', (await ProductModel.countDocuments({ shopId: shop1, nameLower: 'azithral 500' })) === 0);
  check('save with an error row → 422', (await owner.post('/products/import', { clientRequestId: randomUUID(), dryRun: false, rows })).status === 422);
  const importId = randomUUID();
  const saved = await owner.post('/products/import', { clientRequestId: importId, dryRun: false, rows: rows.slice(0, 3) });
  check('clean rows save → 200', saved.status === 200 && (saved.json.data as { saved: boolean }).saved, code(saved));
  await owner.post('/products/import', { clientRequestId: importId, dryRun: false, rows: rows.slice(0, 3) });
  check('same import sent twice → products and batches once', (await ProductModel.countDocuments({ shopId: shop1, nameLower: 'azithral 500' })) === 1 && (await BatchModel.countDocuments({ shopId: shop1, batchNumber: 'AZ77' })) === 1);
  const az = await ProductModel.findOne({ shopId: shop1, nameLower: 'azithral 500' }).lean();
  check('Azithral: 20 STRIP of 5 = 100 TABLET at ₹119.50', az?.stock.sellable === 100 && az.lastMrp === 11950, JSON.stringify(az?.stock));
  check('Dolo got batch DL2501 (150 tablets)', (await BatchModel.findOne({ shopId: shop1, batchNumber: 'DL2501' }).lean())?.quantity === 150);
  check('cashier can’t import → 403', (await cashier.post('/products/import', { clientRequestId: randomUUID(), dryRun: true, rows })).status === 403);
  check('201 rows → 422', (await owner.post('/products/import', { clientRequestId: randomUUID(), dryRun: true, rows: Array.from({ length: 201 }, () => rows[0]) })).status === 422);

  section('17. Deactivate + categories in use');
  const pd = data<Product>(await owner.get(`/products/${dolo}`));
  check('deactivate → 200', (await owner.post(`/products/${dolo}/active`, { isActive: false, version: pd.version })).status === 200);
  check('no opening stock into a deactivated product → 409', (await owner.post('/stock/opening', opening({ batchNumber: 'X9' }))).status === 409);
  check('gone from the normal list, in “inactive”', !ids(await owner.get('/products')).includes('Dolo 650 Tablet') && ids(await owner.get('/products?status=inactive')).includes('Dolo 650 Tablet'));
  const tab = data<Category[]>(await owner.get('/categories')).find((c) => c.name === 'Eye drops');
  check('unused custom category can be removed', (await owner.del(`/categories/${tab?.id ?? ''}`)).status === 200);
  const movers = data<{ type: string }[]>(await owner.get(`/stock/movements?productId=${dolo}&type=OPENING`));
  check('movements filter by product + type', movers.length > 0 && movers.every((m) => m.type === 'OPENING'));

  await h.close();
  finish();
}

main().catch(crash);
