// Barcode labels (Pro, optional): the shop's own code only when asked, labels from products or a purchase, the PDF
// sheet / roll laid out right, the plan and the permissions guarding it.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/LBL20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const DAY = 86_400_000;
const IST = 5.5 * 60 * 60 * 1000;
const isoDay = (offsetDays = 0) => new Date(Date.now() + IST + offsetDays * 86_400_000).toISOString().slice(0, 10);

interface Bars { format: string; bars: string; quiet: number }
interface Row { key: string; productId: string; name: string; unit: string; barcode: string | null; bars: Bars | null; batches: { id: string; batchNumber: string; mrp: number; quantity: number }[]; batchId: string | null; copies: number }

async function main() {
  const h = await startHarness();
  const { barsOf, checkDigit, inStoreCode } = await import('../src/modules/labels/barcode.js');
  const { pdfPageCount, pdfWords } = await import('../src/core/pdf-text.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { ProductModel } = await import('../src/modules/products/product.model.js');

  section('1. Bars');
  const ean = barsOf('4006381333931');
  check('EAN-13 with a right check digit → EAN13, 95 modules, guards 101 … 01010 … 101', ean.format === 'EAN13' && ean.bars.length === 95 && ean.bars.startsWith('101') && ean.bars.slice(45, 50) === '01010' && ean.bars.endsWith('101'));
  check('UPC-A (12 digits) → the same bars as EAN-13 with a leading 0', barsOf('036000291452').bars === barsOf('0036000291452').bars && barsOf('036000291452').format === 'EAN13');
  check('EAN-8 → 67 modules', barsOf('96385074').format === 'EAN8' && barsOf('96385074').bars.length === 67);
  check('a 13-digit code with a wrong check digit is not dressed as EAN → Code 128', barsOf('4006381333932').format === 'CODE128');
  const even = barsOf('12345678');
  const odd = barsOf('123456789');
  const text = barsOf('ABC-123');
  // Code 128: start + data + check + stop; every symbol 11 modules, the stop 13 — so the width says how it was packed.
  check('even digits pack two to a symbol (set C): start + 4 + check + stop', even.format === 'CODE128' && even.bars.length === 11 * 6 + 13);
  check('odd digits: one in set B, a switch, then pairs: start + 1 + switch + 4 + check + stop', odd.bars.length === 11 * 8 + 13);
  check('letters (set B): one symbol each', text.bars.length === 11 * 9 + 13);
  check('every Code 128 starts with a bar and ends with the stop 11000111010 + 11', text.bars.startsWith('1') && text.bars.endsWith('1100011101011'));
  const own = inStoreCode(1);
  check(`the shop's own code: 13 digits, 29…, a right check digit (${own})`, /^29\d{11}$/.test(own) && checkDigit(own.slice(0, 12)) === Number(own[12]) && barsOf(own).format === 'EAN13');
  check('…and the next one differs', inStoreCode(2) !== own);

  section('2. Shop, products, stock');
  const owner = await h.signIn('rohit@label1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Label Pharmacy'))).id;
  owner.shopId = shopId;
  await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 10 } });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'sunita@label1.test', name: 'Sunita', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('sunita@label1.test');
  await cashier.post(`/invitations/${data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Sunita' });
  cashier.shopId = shopId;
  const other = await h.signIn('mina@label2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Other Medical'))).id;

  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id ?? '';
  const mk = async (name: string, barcode = '') => data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0, barcode })).id;
  const maker = `890123456789${String(checkDigit('890123456789'))}`;
  const dolo = await mk('Dolo 650 Tablet', maker);
  const amox = await mk('Amoxyclav 625');
  const pan = await mk('Pan 40');
  const typed = await mk('Shelcal 500');
  for (const [p, b, exp, mrp] of [[dolo, 'DL-LATE', '2029-06', 3600], [dolo, 'DL-SOON', '2027-09', 3350], [amox, 'AM1', '2028-03', 9200]] as const) {
    await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId: p, batchNumber: b, expiry: exp, quantity: 450, mrp, purchaseRate: 1950 });
  }

  section('3. What to print');
  const rows = data<Row[]>(await owner.get(`/labels/items?ids=${dolo},${amox}`));
  const d = rows[0];
  check('two rows, in the order asked', rows.length === 2 && d?.name === 'Dolo 650 Tablet' && rows[1]?.name === 'Amoxyclav 625');
  check("the maker's barcode with its bars; no code → null", d?.barcode === maker && d.bars?.format === 'EAN13' && rows[1]?.barcode === null && rows[1].bars === null);
  check('batches: the next to sell on top and picked, MRP per strip, stock in strips', d?.batches[0]?.batchNumber === 'DL-SOON' && d.batchId === d.batches[0].id && d.batches[0].mrp === 3350 && d.batches[0].quantity === 30 && d.copies === 1);
  check('nothing asked → 422', (await owner.get('/labels/items')).status === 422);
  const noCode = await owner.post('/labels/pdf', { layout: 'a4-65', skip: 0, show: { mrp: true, batch: false, shop: false }, items: [{ productId: amox, copies: 1 }] });
  check('a product without a barcode can’t be printed → 422, says so', noCode.status === 422 && /Amoxyclav 625 has no barcode yet/.test(noCode.json.error?.message ?? ''), code(noCode));

  section('4. The shop’s own barcode — only when asked');
  check('a cashier (no product edit) can’t give barcodes → 403', (await cashier.post('/labels/barcodes', { productIds: [amox] })).status === 403);
  check('…but can see what to print', (await cashier.get(`/labels/items?ids=${dolo}`)).status === 200);
  // Someone typed the shop's next own number on a product by hand: it is skipped, never given twice.
  await ProductModel.updateOne({ shopId, _id: typed }, { $set: { barcode: inStoreCode(2) } });
  const given = await owner.post('/labels/barcodes', { productIds: [amox, pan, dolo] });
  const g = data<{ productId: string; barcode: string; bars: Bars }[]>(given);
  check('two given (Dolo keeps the maker’s), said so', given.status === 200 && g.length === 2 && given.json.message === '2 barcodes given', code(given));
  check(`own codes in order, the hand-typed one skipped (${g.map((x) => x.barcode).join(', ')})`, g[0]?.barcode === inStoreCode(1) && g[1]?.barcode === inStoreCode(3));
  check('the product now carries it', data<{ barcode: string }>(await owner.get(`/products/${amox}`)).barcode === inStoreCode(1));
  check('audit: who gave which code', (await AuditLogModel.countDocuments({ shopId, module: 'products', text: { $regex: `gave Amoxyclav 625 the shop's own barcode ${inStoreCode(1)}` } })) === 1);
  const again = data<unknown[]>(await owner.post('/labels/barcodes', { productIds: [amox] }));
  check('asked again: nothing changes', again.length === 0 && data<{ barcode: string }>(await owner.get(`/products/${amox}`)).barcode === inStoreCode(1));
  check('the counter now finds it by the code', data<{ name: string }[]>(await owner.get(`/products?q=${inStoreCode(1)}`))[0]?.name === 'Amoxyclav 625');

  section('5. From a purchase');
  const sup = data<{ id: string }>(await owner.post('/suppliers', { name: 'Sharma Distributors', contactPerson: 'Anil Sharma', phone: '98311 22334', email: 'orders@sharma.test', gstin: '19ABCDE1234F1Z5', drugLicense: 'WB/KOL/20B/1189', creditDays: 30, address: 'Bagri Market, Kolkata' })).id;
  const line = (over: Record<string, unknown>) => ({ productId: dolo, batchNumber: 'DL2409', expiry: '2027-08', quantity: 30, freeQuantity: 2, unit: 'STRIP', rate: 2340, discountPercent: 0, mrp: 3350, gstRate: 12, rack: '', ...over });
  const pur = await owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: sup, invoiceNumber: 'SD/26/77', invoiceDate: isoDay(-1), lines: [line({}), line({ productId: amox, batchNumber: 'AM5512', expiry: '2028-03', quantity: 2, freeQuantity: 0, unit: 'BOX', rate: 68_000, mrp: 9200 })] });
  check('purchase saved', pur.status === 201, code(pur));
  const fromPur = data<Row[]>(await owner.get(`/labels/items?purchase=${data<{ id: string }>(pur).id}`));
  const pd = fromPur[0];
  check('one row per line, a label per strip received (30 + 2 free; 2 boxes of 10)', fromPur.length === 2 && pd?.copies === 32 && fromPur[1]?.copies === 20, fromPur.map((r) => r.copies).join(','));
  check('the batch received is the one picked', pd?.batches.find((b) => b.id === pd.batchId)?.batchNumber === 'DL2409' && fromPur[1]?.batches.find((b) => b.id === fromPur[1]?.batchId)?.batchNumber === 'AM5512');

  section('6. The PDF');
  // LABELS_OUT=<dir>: the PDFs are kept there, to look at and to read the bars back with a scanner library.
  const keep = (name: string, file: Buffer) => { if (process.env.LABELS_OUT) writeFileSync(path.join(process.env.LABELS_OUT, `${name}.pdf`), file); };
  const pdfOf = async (body: Record<string, unknown>, name?: string) => {
    const r = await owner.post('/labels/pdf', { layout: 'a4-65', skip: 0, show: { mrp: true, batch: false, shop: false }, ...body });
    if (name && r.status === 200) keep(name, r.body);
    return { r, pages: r.status === 200 ? await pdfPageCount(r.body) : 0, text: r.status === 200 ? (await pdfWords(r.body, 3)).map((p) => p.map((w) => w.text).join(' ')).join(' | ') : '' };
  };
  const sheet = await pdfOf({ items: [{ productId: dolo, copies: 70 }] });
  check('70 labels on 65-label sheets → 2 pages, a PDF file', sheet.r.status === 200 && sheet.r.headers.get('content-type') === 'application/pdf' && sheet.pages === 2, code(sheet.r));
  check('label: name, MRP per strip (the batch that sells next), the code under the bars', sheet.text.includes('Dolo 650 Tablet') && sheet.text.includes('MRP ₹33.50/strip') && sheet.text.includes(maker), sheet.text.slice(0, 200));
  const halfUsed = await pdfOf({ skip: 60, items: [{ productId: dolo, copies: 5 }] });
  const spill = await pdfOf({ skip: 60, items: [{ productId: dolo, copies: 6 }] });
  check('a half-used sheet: start at label 61 — 5 fit on it, the 6th goes to a new sheet', halfUsed.pages === 1 && spill.pages === 2);
  const late = d?.batches.find((b) => b.batchNumber === 'DL-LATE')?.id;
  const full = await pdfOf({ show: { mrp: true, batch: true, shop: true }, items: [{ productId: dolo, batchId: late, copies: 1 }, { productId: amox, copies: 1 }] }, 'a4-65');
  await pdfOf({ layout: 'a4-24', show: { mrp: true, batch: true, shop: true }, items: [{ productId: dolo, batchId: late, copies: 1 }, { productId: amox, copies: 1 }] }, 'a4-24');
  await pdfOf({ layout: 'roll-38x25', show: { mrp: true, batch: true, shop: false }, items: [{ productId: dolo, copies: 1 }, { productId: amox, copies: 1 }] }, 'roll-38x25');
  await pdfOf({ layout: 'roll-50x25', show: { mrp: true, batch: true, shop: true }, items: [{ productId: dolo, copies: 1 }, { productId: amox, copies: 1 }] }, 'roll-50x25');
  const mixed = data<{ id: string }>(await owner.post('/products', { name: 'Volini Gel 30g', company: 'Sun Pharma', salt: '', strength: '', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0, barcode: 'VG-30-77' })).id;
  await pdfOf({ layout: 'roll-38x25', show: { mrp: false, batch: false, shop: false }, items: [{ productId: mixed, copies: 1 }] }, 'code128');
  check('a batch picked: its MRP, batch and expiry; the shop name on top', full.text.includes('MRP ₹36.00/strip') && full.text.includes('B.No DL-LATE · Exp 06/29') && full.text.includes('Label Pharmacy') && full.text.includes(inStoreCode(1)), full.text.slice(0, 300));
  const bare = await pdfOf({ show: { mrp: false, batch: false, shop: false }, items: [{ productId: pan, copies: 1 }] });
  check('MRP off, and a product with no stock: name and code only', bare.r.status === 200 && !bare.text.includes('MRP') && bare.text.includes('Pan 40') && bare.text.includes(inStoreCode(3)));
  const roll = await pdfOf({ layout: 'roll-50x25', items: [{ productId: dolo, copies: 3 }] });
  check('a roll: one label a page → 3 pages', roll.pages === 3);
  check('a sheet has 65 labels: skip 65 → 422', (await pdfOf({ skip: 65, items: [{ productId: dolo, copies: 1 }] })).r.status === 422);
  check('more than 2,000 labels → 422', (await pdfOf({ items: [{ productId: dolo, copies: 500 }, { productId: amox, copies: 500 }, { productId: pan, copies: 500 }, { productId: typed, copies: 500 }, { productId: dolo, copies: 1 }] })).r.status === 422);
  check("another product's batch → 422", (await pdfOf({ items: [{ productId: amox, batchId: late, copies: 1 }] })).r.status === 422);

  section('7. Tenancy and plan');
  check("another shop: someone else's products are not there", data<Row[]>(await other.get(`/labels/items?ids=${dolo}`)).length === 0);
  check('…their PDF → 404', (await other.post('/labels/pdf', { layout: 'a4-65', skip: 0, show: { mrp: true, batch: false, shop: false }, items: [{ productId: dolo, copies: 1 }] })).status === 404);
  check('…and no barcode given to it', data<unknown[]>(await other.post('/labels/barcodes', { productIds: [typed] })).length === 0);
  await SubscriptionModel.updateOne({ shopId }, { $set: { planCode: 'basic-monthly', status: 'active', endDate: new Date(Date.now() + 30 * DAY) } });
  const basic = await owner.get(`/labels/items?ids=${dolo}`);
  check('Basic plan → 403 PLAN_UPGRADE', basic.status === 403 && basic.json.error?.code === 'PLAN_UPGRADE', code(basic));
  check('…billing by the barcode still works (labels are only extra)', data<{ name: string }[]>(await owner.get(`/products?q=${maker}`))[0]?.name === 'Dolo 650 Tablet');

  finish();
}

main().catch(crash);
