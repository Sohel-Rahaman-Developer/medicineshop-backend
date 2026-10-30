// Tally export checks: a month of every kind of entry, each voucher balanced to the paisa and tied back to the bills.
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
const thisMonth = isoDay().slice(0, 7);
const lastMonth = (() => {
  const [y = 0, m = 1] = thisMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();

interface Line { ledger: string; dr: boolean; amount: number }
interface Vch { type: string; number: string; party: string; lines: Line[] }
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const TAGS = { VOUCHERNUMBER: /<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/, PARTYLEDGERNAME: /<PARTYLEDGERNAME>([^<]*)<\/PARTYLEDGERNAME>/ };
const tag = (xml: string, name: keyof typeof TAGS) => unesc(TAGS[name].exec(xml)?.[1] ?? '');
/** Tally's way: a debit is a negative amount with ISDEEMEDPOSITIVE Yes. */
const parse = (xml: string): Vch[] =>
  [...xml.matchAll(/<VOUCHER [^>]*VCHTYPE="([^"]+)"[^>]*>([\s\S]*?)<\/VOUCHER>/g)].map((m) => ({
    type: m[1] ?? '',
    number: tag(m[2] ?? '', 'VOUCHERNUMBER'),
    party: tag(m[2] ?? '', 'PARTYLEDGERNAME'),
    lines: [...(m[2] ?? '').matchAll(/<LEDGERNAME>([^<]*)<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((x) => ({ ledger: unesc(x[1] ?? ''), dr: x[2] === 'Yes', amount: Math.round(Number(x[3]) * 100) })),
  }));
/** As the file writes it: a debit below 0, a credit above. */
const on = (v: Vch | undefined, ledger: string) => v?.lines.filter((l) => l.ledger === ledger).reduce((a, l) => a + l.amount, 0) ?? 0;
const sumOn = (vs: Vch[], test: (ledger: string) => boolean) => vs.reduce((a, v) => a + v.lines.filter((l) => test(l.ledger)).reduce((b, l) => b + l.amount, 0), 0);

async function main() {
  const h = await startHarness();
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');

  const owner = await h.signIn('rohit@tally1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Tally Test Pharmacy'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const ok = async (what: string, p: Promise<Res>) => {
    const r = await p;
    if (r.status !== 200 && r.status !== 201) throw new Error(`${what}: ${code(r)}`);
    return r;
  };
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (name: string, units: Record<string, unknown>, gstRate: number) =>
    data<{ id: string }>(await ok(`product ${name}`, owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((x) => x.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate, units, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 }))).id;
  const dolo = await mk('Dolo 650 Tablet', units15, 12);
  const amox = await mk('Augmentin 625', units10, 12);
  const pan = await mk('Pan 40 Tablet', units15, 12);
  const volini = await mk('Volini Spray', units15, 18);
  const stock = (productId: string, batchNumber: string, mrp: number) => ok('stock', owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId, batchNumber, expiry: '2028-12', quantity: 300, mrp, purchaseRate: Math.round(mrp * 0.65) }));
  await stock(dolo, 'DL1', 3000);
  await stock(amox, 'AM1', 9200);
  await stock(pan, 'PN1', 3350);
  await stock(volini, 'VL1', 20_000);
  const bill = (items: Record<string, unknown>[], payments: Record<string, unknown>[], over: Record<string, unknown> = {}) => ok('bill', owner.post('/sales', { clientRequestId: randomUUID(), items, payments, ...over }));
  type Saved = { id: string; billNumber: string };

  const ratna = data<{ id: string; version: number }>(await ok('customer', owner.post('/customers', { name: 'Ratna Sen', phone: '98300 12345' })));
  await ok('limit', owner.put(`/customers/${ratna.id}`, { name: 'Ratna Sen', phone: '98300 12345', creditLimit: 50_000, version: ratna.version }));

  section('1. A month of the shop’s work');
  const a = data<Saved>(await bill([{ productId: dolo, quantity: 2, unit: 'STRIP' }, { productId: amox, quantity: 1, unit: 'STRIP' }], [{ mode: 'CASH', amount: 15_200 }]));
  const b = data<Saved>(await bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], [{ mode: 'UPI', amount: 9200 }]));
  const c = data<Saved>(await bill([{ productId: dolo, quantity: 1, unit: 'STRIP' }], [{ mode: 'CASH', amount: 1000 }, { mode: 'CREDIT', amount: 2000 }], { customerId: ratna.id }));
  await bill([{ productId: volini, quantity: 1, unit: 'STRIP' }], [{ mode: 'CARD', amount: 20_000 }]);
  // 5 loose tablets: ₹11.17 billed ₹11 — a −₹0.17 round off.
  const e = data<Saved>(await bill([{ productId: pan, quantity: 5, unit: 'TABLET' }], [{ mode: 'CASH', amount: 1100 }]));
  await ok('udhaar collected', owner.post(`/customers/${ratna.id}/payments`, { clientRequestId: randomUUID(), amount: 500, mode: 'CASH' }));
  await ok('cash return', owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: a.id, items: [{ line: 0, quantity: 7, reason: 'Bought extra' }], refundMode: 'CASH' }));
  await ok('UPI return', owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: b.id, items: [{ line: 0, quantity: 5, reason: 'Bought extra' }], refundMode: 'UPI', refundRef: 'T2610301234' }));
  await ok('udhaar return', owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: c.id, items: [{ line: 0, quantity: 15, reason: 'Bought extra' }], refundMode: 'ADJUST_CREDIT' }));
  const order = (advance: number, advanceMode: string) => ok('order', owner.post('/orders', { clientRequestId: randomUUID(), customer: { name: 'Gopal Das' }, items: [{ productId: dolo, qty: 1 }], advance, advanceMode }));
  await order(10_000, 'CASH');
  const o2 = data<{ id: string }>(await order(5000, 'UPI'));
  await ok('order refund', owner.post(`/orders/${o2.id}/cancel`, { reason: 'Never came', refundMode: 'UPI' }));
  const sup = data<{ id: string }>(await ok('supplier', owner.post('/suppliers', { name: 'Sharma & Sons', contactPerson: '', phone: '98311 22334', email: '', gstin: '19ABCDE1234F1Z5', drugLicense: '', creditDays: 30, address: '' }))).id;
  const pur = data<{ id: string; grandTotal: number; invoiceNumber?: string }>(await ok('purchase', owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: sup, invoiceNumber: 'SS/26/77', invoiceDate: isoDay(), lines: [{ productId: dolo, batchNumber: 'DL9', expiry: '2028-08', quantity: 10, freeQuantity: 0, unit: 'STRIP', rate: 2000, discountPercent: 0, mrp: 3000, gstRate: 12, rack: '' }] })));
  const dl9 = await BatchModel.findOne({ shopId: shop1, batchNumber: 'DL9' }).lean();
  await ok('return to supplier', owner.post('/purchase-returns', { clientRequestId: randomUUID(), supplierId: sup, reason: 'DAMAGED', lines: [{ batchId: String(dl9?._id), quantity: 15 }] }));
  await ok('supplier paid', owner.post(`/suppliers/${sup}/payments`, { clientRequestId: randomUUID(), amount: 50_000, mode: 'UPI', reference: 'UTR778', fromDrawer: false }));
  await ok('rent', owner.post('/expenses', { clientRequestId: randomUUID(), date: isoDay(), category: 'Rent', description: 'Shop rent', amount: 1_500_000, paymentMode: 'BANK', fromDrawer: false, vendor: '', referenceNumber: '' }));
  // Cancelled the same month: in neither file. Billed last month, cancelled now: last month keeps it, this month reverses it.
  const y = data<Saved>(await bill([{ productId: dolo, quantity: 1, unit: 'STRIP' }], [{ mode: 'CASH', amount: 3000 }]));
  await ok('cancel Y', owner.post(`/sales/${y.id}/cancel`, { reason: 'Wrong item' }));
  const x = data<Saved>(await bill([{ productId: dolo, quantity: 1, unit: 'STRIP' }], [{ mode: 'CASH', amount: 3000 }]));
  await ok('cancel X', owner.post(`/sales/${x.id}/cancel`, { reason: 'Customer changed mind' }));
  await SaleModel.updateOne({ shopId: shop1, _id: x.id }, { $set: { billDate: new Date(`${lastMonth}-15T06:30:00Z`) } });

  section('2. What goes in — on screen');
  type Summary = { month: string; vouchers: number; counts: { what: string; n: number; value: number }[]; ledgers: { name: string; group: string }[] };
  const sr = await owner.get(`/reports/tally?month=${thisMonth}`);
  const sum = data<Summary>(sr);
  const n = (what: string) => sum.counts.find((x) => x.what === what)?.n ?? 0;
  check('5 bills (the two cancelled ones left out)', sr.status === 200 && n('Bills') === 5, code(sr) + JSON.stringify(sum.counts));
  check('1 bill from last month cancelled now · 3 customer returns · 1 purchase · 1 return to supplier', n('Bills cancelled from earlier months') === 1 && n('Customer returns') === 3 && n('Purchases') === 1 && n('Returns to suppliers') === 1, JSON.stringify(sum.counts));
  check('1 supplier payment · 1 udhaar received · 1 expense · 3 advance entries (2 taken, 1 refunded)', n('Supplier payments') === 1 && n('Udhaar received') === 1 && n('Expenses') === 1 && n('Order advances') === 3, JSON.stringify(sum.counts));
  check('the ledgers list names Tally’s own groups', sum.ledgers.some((l) => l.name === 'Ratna Sen (2345)' && l.group === 'Sundry Debtors') && sum.ledgers.some((l) => l.name === 'Sharma & Sons' && l.group === 'Sundry Creditors') && sum.ledgers.some((l) => l.name === 'Sales GST 18%' && l.group === 'Sales Accounts'), JSON.stringify(sum.ledgers));

  section('3. The entries file — every voucher balances');
  const fr = await owner.get(`/reports/tally/file?month=${thisMonth}&part=entries`);
  check('an XML file named for Tally', fr.status === 200 && (fr.headers.get('content-type') ?? '').startsWith('application/xml') && /Tally-2-entries-\d{4}-\d{2}\.xml/.test(fr.headers.get('content-disposition') ?? '') && fr.text.startsWith('<?xml') && fr.text.includes('<TALLYREQUEST>Import Data</TALLYREQUEST>'), `${code(fr)} ${fr.headers.get('content-type') ?? ''} ${fr.headers.get('content-disposition') ?? ''}`);
  const vs = parse(fr.text);
  check(`as many vouchers as the screen says (${String(sum.vouchers)})`, vs.length === sum.vouchers && vs.length > 0, String(vs.length));
  const unbalanced = vs.filter((v) => v.lines.reduce((a, l) => a + l.amount, 0) !== 0);
  check('Dr = Cr in every voucher, to the paisa', unbalanced.length === 0, JSON.stringify(unbalanced.slice(0, 2)));
  check('debits are negative with ISDEEMEDPOSITIVE Yes, credits positive with No', vs.every((v) => v.lines.every((l) => l.dr === l.amount < 0)));
  const lr = await owner.get(`/reports/tally/file?month=${thisMonth}&part=ledgers`);
  const named = new Set([...lr.text.matchAll(/<LEDGER NAME="([^"]*)"/g)].map((m) => unesc(m[1] ?? '')));
  const used = new Set(vs.flatMap((v) => v.lines.map((l) => l.ledger)));
  check('every ledger the entries use is in the ledgers file', [...used].every((l) => named.has(l)), [...used].filter((l) => !named.has(l)).join());
  check('“&” is written as &amp; — the file stays valid XML', lr.text.includes('Sharma &amp; Sons') && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(lr.text));
  check('GST ledgers carry their duty head; the supplier its GSTIN', /<LEDGER NAME="Output CGST"[\s\S]*?<GSTDUTYHEAD>Central Tax<\/GSTDUTYHEAD>/.test(lr.text) && /<LEDGER NAME="Sharma &amp; Sons"[\s\S]*?<PARTYGSTIN>19ABCDE1234F1Z5<\/PARTYGSTIN>/.test(lr.text));

  section('4. Tied back to the bills');
  const sales = vs.filter((v) => v.type === 'Sales');
  const live = await SaleModel.find({ shopId: shop1, status: { $ne: 'cancelled' } }).lean();
  const want = live.reduce((acc, s) => ({ taxable: acc.taxable + s.taxableAmount, cgst: acc.cgst + s.cgst, round: acc.round + s.roundOff }), { taxable: 0, cgst: 0, round: 0 });
  check(`sales ledgers = the bills’ taxable value (₹${(want.taxable / 100).toFixed(2)})`, sumOn(sales, (l) => l.startsWith('Sales GST ')) === want.taxable, String(sumOn(sales, (l) => l.startsWith('Sales GST '))));
  check('Output CGST = the bills’ CGST', sumOn(sales, (l) => l === 'Output CGST') === want.cgst);
  check('Round Off = the bills’ own round off (−₹0.17 on the loose tablets)', sumOn(sales, (l) => l === 'Round Off') === want.round && want.round === -17, `${String(sumOn(sales, (l) => l === 'Round Off'))} vs ${String(want.round)}`);
  const vA = sales.find((v) => v.number === a.billNumber);
  check('bill A: Cash Dr ₹152 · Sales GST 12% Cr', on(vA, 'Cash') === -15_200 && on(vA, 'Sales GST 12%') > 0 && vA?.party === 'Cash');
  const vC = sales.find((v) => v.number === c.billNumber);
  check('udhaar bill: Ratna Dr ₹20, Cash Dr ₹10, the party is Ratna', on(vC, 'Ratna Sen (2345)') === -2000 && on(vC, 'Cash') === -1000 && vC?.party === 'Ratna Sen (2345)');
  check('UPI and card go to Bank', on(sales.find((v) => v.number === b.billNumber), 'Bank') === -9200);
  check('the loose-tablet bill: Round Off Dr ₹0.17',on(sales.find((v) => v.number === e.billNumber), 'Round Off') === -17);
  check('the bill cancelled the same month is in no voucher', !vs.some((v) => v.number.startsWith(y.billNumber)));
  const rev = vs.find((v) => v.number === `${x.billNumber}-X`);
  check('last month’s bill cancelled now → a Credit Note: Cash Cr ₹30, sales Dr', rev?.type === 'Credit Note' && on(rev, 'Cash') === 3000 && on(rev, 'Sales GST 12%') < 0);
  const notes = vs.filter((v) => v.type === 'Credit Note' && !v.number.endsWith('-X'));
  check('returns: cash Cr ₹14 · UPI to Bank Cr ₹46 · udhaar return takes Ratna’s ₹15 off and gives ₹15 cash', notes.some((v) => on(v, 'Cash') === 1400) && notes.some((v) => on(v, 'Bank') === 4600) && notes.some((v) => on(v, 'Ratna Sen (2345)') === 1500 && on(v, 'Cash') === 1500), JSON.stringify(notes.map((v) => v.lines)));
  const vP = vs.find((v) => v.type === 'Purchase');
  check(`purchase: Sharma & Sons Cr ₹${(pur.grandTotal / 100).toFixed(2)} · Input CGST + SGST Dr`, on(vP, 'Sharma & Sons') === pur.grandTotal && on(vP, 'Input CGST') < 0 && on(vP, 'Input SGST') < 0 && vP?.number === 'SS/26/77');
  check('return to supplier: a Debit Note, the supplier Dr', vs.some((v) => v.type === 'Debit Note' && on(v, 'Sharma & Sons') < 0));
  check('supplier paid by UPI: supplier Dr ₹500, Bank Cr', vs.some((v) => v.type === 'Payment' && on(v, 'Sharma & Sons') === -50_000 && on(v, 'Bank') === 50_000));
  check('udhaar collected: Receipt — Cash Dr ₹5, Ratna Cr', vs.some((v) => v.type === 'Receipt' && on(v, 'Cash') === -500 && on(v, 'Ratna Sen (2345)') === 500));
  check('rent ₹15,000 by bank: Rent Dr, Bank Cr', vs.some((v) => v.type === 'Payment' && on(v, 'Rent') === -1_500_000 && on(v, 'Bank') === 1_500_000));
  check('advances: ₹100 cash and ₹50 UPI in, ₹50 refunded by UPI', vs.filter((v) => on(v, 'Customer advances') === 10_000 || on(v, 'Customer advances') === 5000).length === 2 && vs.some((v) => v.type === 'Payment' && on(v, 'Customer advances') === -5000 && on(v, 'Bank') === 5000));

  section('5. Last month, the plan and who may');
  const prev = parse((await owner.get(`/reports/tally/file?month=${lastMonth}&part=entries`)).text);
  check('last month’s file still has the bill cancelled later, as a sale', prev.some((v) => v.type === 'Sales' && v.number === x.billNumber && on(v, 'Cash') === -3000));
  check('a bad month → 422 · a bad part → 422', (await owner.get('/reports/tally?month=2026-13')).status === 422 && (await owner.get(`/reports/tally/file?month=${thisMonth}&part=all`)).status === 422);
  const roles = data<{ id: string; key: string }[]>(await owner.get('/roles'));
  await ok('invite', owner.post('/staff', { email: 'sunita@tally1.test', name: 'sunita', roleId: roles.find((r) => r.key === 'cashier')?.id }));
  const cashier = await h.signIn('sunita@tally1.test');
  const inv = data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? '';
  await ok('accept', cashier.post(`/invitations/${inv}/accept`, { name: 'sunita' }));
  cashier.shopId = shop1;
  check('cashier (no reports) → 403', (await cashier.get(`/reports/tally?month=${thisMonth}`)).status === 403 && (await cashier.get(`/reports/tally/file?month=${thisMonth}&part=entries`)).status === 403);
  const other = await h.signIn('amit@tally2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Other Pharmacy'))).id;
  check('another shop sees none of these', data<Summary>(await other.get(`/reports/tally?month=${thisMonth}`)).vouchers === 0);

  finish();
}

main().catch(crash);
