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

interface Reg { key: string; name: string; cols: { key: string }[]; rows: Record<string, string | number | null>[]; count: number; summary: { schedule: string; lines: number; docs: number }[]; totals: { bills: number; billTotal: number; lineTotal: number } | null; groups: Group[] | null }
interface Group { key: string; label: string; sub: string; medicines: number; docs: number; lines: number; qty: string; amount: number | null }

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
  const tt = (r: Reg) => JSON.stringify(r.totals);
  check('totals: 3 bills ₹152 + ₹79 + ₹30 = ₹261 · lines ₹260.50 (bill B ₹78.50 rounded off to ₹79)', all.totals?.bills === 3 && all.totals.billTotal === 26_100 && all.totals.lineTotal === 26_050, tt(all));
  check('totals with Schedule H1: 2 bills’ full amounts ₹231, these lines ₹92 + ₹45 = ₹137', h1.totals?.bills === 2 && h1.totals.billTotal === 23_100 && h1.totals.lineTotal === 13_700, tt(h1));
  const mid = await reg('sales', 'min=5000&max=10000');
  check('totals of bills ₹50–₹100: every such bill, none left out → 1 bill ₹79', mid.totals?.bills === 1 && mid.totals.billTotal === 7900, tt(mid));
  const by = async (kind: string, view: string, q = '') => (await reg(kind, `view=${view}${q ? `&${q}` : ''}`)).groups ?? [];
  const brief = (g: Group | undefined) => (g ? `${g.label}|${g.sub}|${String(g.medicines)}|${String(g.docs)}|${String(g.lines)}|${g.qty}|${String(g.amount)}` : '');
  const byCatRows = await by('sales', 'category');
  check('by category — Tablet: 3 medicines, 3 bills, 4 lines, 75 tablets, ₹60 + ₹45 + ₹33.50 + ₹30 = ₹168.50 · biggest first', brief(byCatRows[0]) === 'Tablet||3|3|4|75 tablets|16850', JSON.stringify(byCatRows));
  check('by category — Capsule: 1 medicine, 1 bill, 10 capsules, ₹92', brief(byCatRows[1]) === 'Capsule||1|1|1|10 capsules|9200');
  check('by category follows the filters: Schedule H1 → Capsule 1 + Tablet 1', (await by('sales', 'category', 'schedule=H1')).map((c) => `${c.label} ${String(c.lines)}`).sort().join() === 'Capsule 1,Tablet 1');
  const docs = await by('sales', 'doctor');
  check('by doctor: Dr. S. Banerjee ₹152 · Dr. P. Roy ₹78.50 · No doctor ₹30', docs.map((g) => `${g.label} ${String(g.docs)} ${String(g.amount)}`).join() === 'Dr. S. Banerjee 1 15200,Dr. P. Roy 1 7850,No doctor 1 3000', JSON.stringify(docs));
  const custs = await by('sales', 'customer');
  check('by customer: Ratna by her phone ₹152 · the two bills with no phone together as Walk-in', brief(custs.find((g) => g.sub === '98300 12345' || g.key.endsWith('12345'))).startsWith('Ratna Sen|') && custs.some((g) => g.label === 'Walk-in' && g.docs === 2 && g.amount === 10_850), JSON.stringify(custs));
  const meds = await by('sales', 'medicine');
  check('by medicine: Dolo 650 — 2 bills, 45 tablets, ₹90, category shown', brief(meds.find((g) => g.label === 'Dolo 650 Tablet')) === 'Dolo 650 Tablet|Tablet|1|2|2|45 tablets|9000', JSON.stringify(meds));
  const days = await by('sales', 'day');
  check('by day: one day, 3 bills, ₹260.50, the date spelled out', days.length === 1 && days[0]?.docs === 3 && days[0].amount === 26_050 && /\d{2} [A-Z][a-z]{2} \d{4}/.test(days[0].label), JSON.stringify(days));
  check('by schedule: full names — Schedule H1 2 lines', (await by('sales', 'schedule')).some((g) => g.label === 'Schedule H1' && g.lines === 2));
  const ss = await by('stock', 'supplier');
  check('stock by supplier: Sharma 2 batches · Opening stock 4 · no money', ss.some((g) => g.label === 'Sharma Distributors' && g.lines === 2) && ss.some((g) => g.key === 'opening' && g.label === 'Opening stock' && g.lines === 4) && ss.every((g) => g.amount === null), JSON.stringify(ss));
  const ps = await by('purchases', 'supplier');
  check('purchases by supplier: Sharma — 1 invoice, 2 medicines, 16 strips received (10 + 1 free + 5), no money', brief(ps[0]) === 'Sharma Distributors||2|1|2|16 strips|null', JSON.stringify(ps));
  check('a view a register does not have → 422 (stock by doctor)', (await owner.get('/reports/registers/stock?view=doctor')).status === 422);
  check('no view → no groups', all.groups === null);
  check('stock and purchases carry no money total', (await reg('stock')).totals === null && (await reg('purchases')).totals === null && (await reg('stock')).groups === null);
  check('a bad schedule → 422 · min above max → 422 · no dates → 422', (await owner.get(`/reports/registers/sales?${range}&schedule=Z`)).status === 422 && (await owner.get(`/reports/registers/sales?${range}&min=500&max=100`)).status === 422 && (await owner.get('/reports/registers/sales')).status === 422);

  section('3. Stock and purchase registers');
  const st = await reg('stock', 'schedule=H1');
  check('H1 stock: Augmentin AM1 + Alprax AX1 and the bought AX9 with its supplier and invoice', st.count === 3 && st.rows.some((r) => r.batch === 'AX9' && r.supplier === 'Sharma Distributors' && r.invoice === 'SD/26/9') && st.rows.some((r) => r.batch === 'AM1' && r.supplier === 'Opening stock'), JSON.stringify(st.rows));
  check('stock quantity in packs: Alprax AX9 = 11 STRIP (10 + 1 free)', st.rows.some((r) => r.batch === 'AX9' && r.qty === '11 STRIP'), JSON.stringify(st.rows.map((r) => r.qty)));
  check('expired only → Pan 40 PN1', (await reg('stock', 'expiry=expired')).rows.map((r) => r.batch).join() === 'PN1');
  check('stock by supplier “sharma” → AX9 + DL9', (await reg('stock', 'party=sharma')).count === 2);
  check('stock by the picked supplier → AX9 + DL9 · opening stock → the 4 opening batches', (await reg('stock', `supplier=${sup}`)).rows.map((r) => r.batch).sort().join() === 'AX9,DL9' && (await reg('stock', 'supplier=opening')).rows.every((r) => r.supplier === 'Opening stock') && (await reg('stock', 'supplier=opening')).count === 4);
  check('purchases by the picked supplier → 2 lines · a bad supplier id → 422', (await reg('purchases', `supplier=${sup}`)).count === 2 && (await owner.get(`/reports/registers/purchases?${range}&supplier=abc`)).status === 422);
  const pr = await reg('purchases', 'schedule=H1');
  check('H1 purchases: Alprax 10 STRIP + 1 free from Sharma, GSTIN shown, no rate', pr.count === 1 && pr.rows[0]?.qty === '10 STRIP' && pr.rows[0].free === '1 STRIP' && pr.rows[0].gstin === '19ABCDE1234F1Z5' && !pr.cols.some((col) => col.key === 'rate'), JSON.stringify(pr.rows));

  section('4. Files, and who may');
  const xl = await owner.get(`/reports/registers/sales/export?${range}&schedule=H1&format=xlsx`);
  check('Excel named for what was chosen (Schedule H1)', xl.status === 200 && /Sales-register.*Schedule-H1/.test(xl.headers.get('content-disposition') ?? ''), `${code(xl)} ${xl.headers.get('content-disposition') ?? ''}`);
  const byCat = await owner.get(`/reports/registers/sales/export?${range}&view=category&format=pdf`);
  check('sales by category PDF', byCat.status === 200 && byCat.text.startsWith('%PDF') && /Sales-by-category/.test(byCat.headers.get('content-disposition') ?? ''), `${code(byCat)} ${byCat.headers.get('content-disposition') ?? ''}`);
  const docXl = await owner.get(`/reports/registers/sales/export?${range}&view=doctor&format=xlsx`);
  check('sales by doctor Excel', docXl.status === 200 && /Sales-by-doctor/.test(docXl.headers.get('content-disposition') ?? ''), `${code(docXl)} ${docXl.headers.get('content-disposition') ?? ''}`);
  const supXl = await owner.get(`/reports/registers/stock/export?supplier=${sup}&format=xlsx`);
  check('stock Excel names the picked supplier', supXl.status === 200 && /Sharma-Distributors/.test(supXl.headers.get('content-disposition') ?? ''), supXl.headers.get('content-disposition') ?? '');
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
  section('5. Prescription photo with the bill (D105)');
  check('off until the owner turns it on', !data<{ rxPhoto: boolean }>(await owner.get('/pos/settings')).rxPhoto);
  check('a cashier cannot turn it on (403)', (await cashier.put('/shop/rx-photo', { on: true })).status === 403);
  await ok('rx photo on', owner.put('/shop/rx-photo', { on: true }));
  check('owner turns it on → the counter sees it', data<{ rxPhoto: boolean }>(await owner.get('/pos/settings')).rxPhoto);
  const { default: sharp } = await import('sharp');
  const lines = Array.from({ length: 30 }, (_, i) => `<text x="80" y="${String(120 + i * 52)}" font-size="38" fill="#1a3a8a">Tab Augmentin 625 · 1-0-1 · 5 days · line ${String(i + 1)}</text>`).join('');
  const page = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1800"><rect width="100%" height="100%" fill="#fbf7ee"/>${lines}</svg>`)).jpeg({ quality: 80 }).toBuffer();
  const sent = await owner.post(`/sales/${b.id}/prescription`, { photo: `data:image/jpeg;base64,${page.toString('base64')}` });
  const saved = data<{ bytes: number; width: number; height: number }>(sent);
  check(`a ${String(Math.round(page.length / 1024))} KB colour photo is stored grey WebP ≤ 150 KB, longest side 1400 px`, sent.status === 200 && saved.bytes <= 150 * 1024 && saved.width === 1400 && saved.height === 1050, `${code(sent)} ${JSON.stringify(saved)}`);
  const back = data<{ dataUrl: string; by: string }>(await owner.get(`/sales/${b.id}/prescription`));
  const stored = Buffer.from(back.dataUrl.split(',')[1] ?? '', 'base64');
  const img = await sharp(stored).metadata();
  // Blue ink on cream paper: R, G and B averages differ in the colour photo and must match in the stored one.
  const mean = async (buf: Buffer) => (await sharp(buf).removeAlpha().stats()).channels.map((c) => c.mean);
  const [r0 = 0, , b0 = 0] = await mean(page);
  const [r1 = 0, g1 = 0, b1 = 0] = await mean(stored);
  check('it comes back as WebP and grey (R = G = B), with who added it', back.dataUrl.startsWith('data:image/webp;base64,') && img.format === 'webp' && Math.abs(r0 - b0) > 5 && Math.abs(r1 - g1) < 1 && Math.abs(g1 - b1) < 1 && back.by.length > 0, `${img.format} colour ${r0.toFixed(1)}/${b0.toFixed(1)} stored ${r1.toFixed(1)}/${g1.toFixed(1)}/${b1.toFixed(1)}`);
  check('the bill says it has one', data<{ hasRxPhoto: boolean }>(await owner.get(`/sales/${b.id}`)).hasRxPhoto);
  check('not an image → 422 · a bill with none → 404', (await owner.post(`/sales/${b.id}/prescription`, { photo: 'data:image/jpeg;base64,aGVsbG8=' })).status === 422 && (await owner.get(`/sales/${a.id}/prescription`)).status === 404);
  check('another shop cannot see or add it (404)', (await other.get(`/sales/${b.id}/prescription`)).status === 404 && (await other.post(`/sales/${b.id}/prescription`, { photo: `data:image/jpeg;base64,${page.toString('base64')}` })).status === 404);

  section('6. How to take, in the customer’s language (D106)');
  const { pdfWords } = await import('../src/core/pdf-text.js');
  type Dosed = Saved & { lines: { item: number }[]; doses: { item: number; freq: string | null; pattern: string | null; meal: string | null; days: number | null }[]; doseLang: string };
  // 6 strips of Dolo take DL9's 75 tablets and 15 more from DL1 (FEFO): one cart line, two bill lines.
  const items = (strips: number) => [
    { productId: dolo, quantity: strips, unit: 'STRIP', dose: { freq: 'BD', meal: 'PC', days: 5 } },
    { productId: amox, quantity: 1, unit: 'STRIP', dose: { pattern: '1-0-½', meal: 'AC' } },
    { productId: alprax, quantity: 1, unit: 'STRIP' },
  ];
  const dosed = async (doseLang: string, strips = 1) => {
    const made = data<Saved>(await bill(items(strips), [{ mode: 'CASH', amount: strips * 3000 + 9200 + 4500 }], { rx, doseLang }));
    const pdfRes = await ok('bill pdf', owner.get(`/sales/${made.id}/pdf`));
    return { sale: data<Dosed>(await owner.get(`/sales/${made.id}`)), pdf: pdfRes.body };
  };
  const en = await dosed('en', 6);
  check(
    'the bill keeps each medicine’s dose by its cart line: Dolo BD · after food · 5 days, Augmentin 1-0-½ before food, Alprax none',
    JSON.stringify(en.sale.doses) === JSON.stringify([{ item: 0, freq: 'BD', pattern: null, meal: 'PC', days: 5 }, { item: 1, freq: null, pattern: '1-0-½', meal: 'AC', days: null }]) && en.sale.doseLang === 'en',
    JSON.stringify(en.sale.doses),
  );
  const enText = (await pdfWords(en.pdf)).flat().map((w) => w.text).join(' ').replace(/\s+/g, ' ');
  const doloLines = en.sale.lines.filter((l) => l.item === 0).length;
  check(`Dolo spans ${String(doloLines)} batches yet its dose prints once; Alprax prints none → 2 lines`, doloLines === 2 && (enText.match(/How to take:/g) ?? []).length === 2, `${String(doloLines)} · ${enText.slice(0, 400)}`);
  check('English words on the bill: “Twice a day · After food · for 5 days” and “Morning 1, Night ½ · Before food”', enText.includes('How to take: Twice a day · After food · for 5 days') && enText.includes('How to take: Morning 1, Night ½ · Before food'), enText);
  const hi = await dosed('hi');
  const bn = await dosed('bn');
  const fonts = (pdf: Buffer) => [...new Set(pdf.toString('latin1').match(/NotoSans(Devanagari|Bengali)/g) ?? [])].join();
  check('Hindi bill embeds the Devanagari font only · Bengali bill the Bengali font only · English needs neither', fonts(hi.pdf) === 'NotoSansDevanagari' && fonts(bn.pdf) === 'NotoSansBengali' && fonts(en.pdf) === '', `${fonts(hi.pdf)} | ${fonts(bn.pdf)} | ${fonts(en.pdf)}`);
  check('the rest of the Hindi bill stays English (TAX INVOICE)', (await pdfWords(hi.pdf)).flat().some((w) => w.text.includes('TAX INVOICE')) && hi.sale.doseLang === 'hi', hi.sale.doseLang);
  const plain = data<Dosed>(await owner.get(`/sales/${a.id}`));
  check('a bill with no dose: none stored, English by default', plain.doses.length === 0 && plain.doseLang === 'en', JSON.stringify(plain.doses));
  const bad = async (dose: Record<string, unknown>, over: Record<string, unknown> = {}) => (await owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: 1, unit: 'STRIP', dose }], payments: [{ mode: 'CASH', amount: 3000 }], ...over })).status;
  check('BD and 1-0-1 together → 422 · “1-1” → 422 · 400 days → 422 · language “fr” → 422', (await bad({ freq: 'BD', pattern: '1-0-1' })) === 422 && (await bad({ pattern: '1-1' })) === 422 && (await bad({ days: 400 })) === 422 && (await bad({ freq: 'OD' }, { doseLang: 'fr' })) === 422);

  finish();
}

main().catch(crash);
