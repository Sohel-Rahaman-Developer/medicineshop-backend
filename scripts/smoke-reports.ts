// B7c checks: the report centre agrees with the P&L and the bills, GST by each line's own rate, B2B buyer on the bill, exports and who may.
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

type Row = Record<string, string | number | null>;
interface Report { cols: { key: string }[]; rows: Row[]; total: Row | null; count: number }
interface Gst { sales: { rate: number; taxable: number; cgst: number; sgst: number }[]; b2b: { gstin: string; taxable: number }[]; outTax: number; inTax: number; net: number; rates: { rate: number; purTax: number }[] }

const IST = 5.5 * 60 * 60 * 1000;
const DAY = 86_400_000;
const isoDay = (offset = 0) => new Date(Date.now() + IST + offset * DAY).toISOString().slice(0, 10);

async function main() {
  const h = await startHarness();
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');

  const owner = await h.signIn('rohit@rep1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    await c.post(`/invitations/${data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? ''}/accept`, { name: email.split('@')[0] });
    c.shopId = shop1;
    return c;
  };
  const cashier = await invite('sunita@rep1.test', 'cashier');
  const keeper = await invite('arif@rep1.test', 'stockKeeper');
  const accountant = await invite('meera@rep1.test', 'accountant');

  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (name: string, gstRate: number, scheduleType = 'OTC', category = 'Tablet') => data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((c) => c.name === category)?.id, scheduleType, storageType: 'NORMAL', hsnCode: '30049099', gstRate, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  const dolo = await mk('Dolo 650 Tablet', 12);
  const alprax = await mk('Alprax 0.25', 5, 'H1');
  // A second category, so the valuation report has two groups to keep apart.
  const syrup = await mk('Benadryl Syrup', 12, 'OTC', 'Syrup');
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL1', expiry: '2028-12', quantity: 150, mrp: 3000, purchaseRate: 1950 });
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: alprax, batchNumber: 'AX1', expiry: '2028-12', quantity: 45, mrp: 5000, purchaseRate: 3000 });
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: syrup, batchNumber: 'BD1', expiry: '2028-12', quantity: 22, mrp: 14_300, purchaseRate: 10_100 });
  const apollo = data<{ id: string }>(await owner.post('/customers', { name: 'Dr Sen', phone: '98300 11111', gstin: '19AAACA1234B1Z5', businessName: 'Apollo Clinic' }));
  const sell = (body: Record<string, unknown>) => owner.post('/sales', { clientRequestId: randomUUID(), payments: [], ...body });
  const a = await sell({ items: [{ productId: dolo, quantity: 2, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: 6000 }] });
  const b = await sell({ customerId: apollo.id, items: [{ productId: dolo, quantity: 1, unit: 'STRIP', discount: { type: 'pct', value: 10 } }], payments: [{ mode: 'CASH', amount: 2700 }] });
  const cH1 = await sell({ items: [{ productId: alprax, quantity: 1, unit: 'STRIP' }], rx: { doctorName: 'Dr A Roy', patientName: 'Mita Das', rxNumber: 'RX-7' }, payments: [{ mode: 'CASH', amount: 5000 }] });
  check('3 bills: Dolo ₹60, Dolo ₹27 (10% off, B2B), Alprax ₹50 (H1, 5%)', [a, b, cH1].every((r) => r.status === 201), [a, b, cH1].map(code).join(' | '));
  const ret = await owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: data<{ id: string }>(a).id, items: [{ line: 0, quantity: 15, reason: 'Not needed' }], refundMode: 'CASH' });
  check('one Dolo strip comes back from the ₹60 bill', ret.status === 201, code(ret));
  const sup = data<{ id: string }>(await owner.post('/suppliers', { name: 'Sharma Distributors', contactPerson: 'Anil', phone: '98311 22334', email: '', gstin: '19ABCDE1234F1Z5', drugLicense: '', creditDays: 30, address: '' })).id;
  await owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: sup, invoiceNumber: 'SD/1', invoiceDate: isoDay(), lines: [{ productId: dolo, batchNumber: 'DL2', expiry: '2029-01', quantity: 10, freeQuantity: 0, unit: 'STRIP', rate: 2000, discountPercent: 0, mrp: 3000, gstRate: 12, rack: '' }] });
  await owner.post('/expenses', { clientRequestId: randomUUID(), date: isoDay(), category: 'Rent', description: '', amount: 12_000, paymentMode: 'UPI', fromDrawer: false, vendor: '', referenceNumber: '' });
  const range = `from=${isoDay()}&to=${isoDay()}`;
  const rep = async (key: string, q = range) => data<Report>(await owner.get(`/reports/r/${key}?${q}`));
  const P = data<{ bills: number; gross: number; salesTaxable: number; revenue: number; salesGst: number; returnsGst: number; net: number }>(await owner.get(`/reports/pnl?${range}`));

  section('1. The catalog and who may');
  const cat = data<{ key: string }[]>(await owner.get('/reports/catalog'));
  check('25 reports in the catalog', cat.length === 25, String(cat.length));
  check('cashier (no reports) → 403', (await cashier.get('/reports/catalog')).status === 403 && (await cashier.get(`/reports/r/sales-register?${range}`)).status === 403);
  check('unknown report → 404; range report without dates → 422; bad month → 422', (await owner.get(`/reports/r/nope?${range}`)).status === 404 && (await owner.get('/reports/r/sales-register')).status === 422 && (await owner.get('/reports/r/daybook?month=2026-13')).status === 422);

  section('2. Sales reports add up to the bills and the P&L');
  const sr = await rep('sales-register');
  check('sales register: 3 bills, total ₹137', sr.count === 3 && sr.total?.total === 13_700, JSON.stringify(sr.total));
  const ps = await rep('product-sales');
  check('product-wise revenue = taxable of all bills (₹125.30, before returns)', ps.total?.revenue === P.salesTaxable && P.salesTaxable === 12_530, `${String(ps.total?.revenue)} vs ${String(P.salesTaxable)}`);
  const dr = await rep('discounts');
  check('discount register: the one 10% bill, ₹3 off ₹30', dr.count === 1 && dr.rows[0]?.discount === 300 && dr.rows[0].pct === 10 && dr.rows[0].mrp === 3000, JSON.stringify(dr.rows[0]));
  const h1 = await rep('h1');
  check('H1 register: Alprax for Mita Das by Dr A Roy, 15 tablets', h1.count === 1 && h1.rows[0]?.patient === 'Mita Das' && h1.rows[0].doctor === 'Dr A Roy' && h1.rows[0].qty === 15, JSON.stringify(h1.rows[0]));
  check('staff report: Rohit, 3 bills', (await rep('staff')).rows[0]?.bills === 3);
  const ss = await rep('sales-summary', `from=${isoDay(-2)}&to=${isoDay()}`);
  check('sales summary over 3 days: one row, today — 3 bills, revenue and profit = the P&L', ss.count === 1 && ss.rows[0]?.day === isoDay() && ss.rows[0].bills === 3 && P.bills === 3 && ss.rows[0].revenue === P.revenue && ss.rows[0].profit === P.gross && P.gross !== P.revenue, JSON.stringify(ss.rows[0]));

  section('3. GST by each line’s own rate, returns taken out');
  const gs = await rep('gst-sales');
  check('two rows (5% and 12%); taxable total = revenue (₹98.52)', gs.count === 2 && gs.total?.taxable === P.revenue && P.revenue === 9852, JSON.stringify(gs.total));
  check('tax total = GST on bills − GST on returns (₹8.48)', Number(gs.total?.cgst) + Number(gs.total?.sgst) === P.salesGst - P.returnsGst && P.salesGst - P.returnsGst === 848);
  check('5% row: Alprax ₹47.62 taxable, ₹1.19 + ₹1.19', gs.rows.some((r) => r.rate === 5 && r.taxable === 4762 && r.cgst === 119 && r.sgst === 119), JSON.stringify(gs.rows));
  const gp = await rep('gst-purchase');
  check('purchase GST: Sharma (GSTIN shown), ₹200 taxable, ₹24 tax', gp.rows[0]?.gstin === '19ABCDE1234F1Z5' && gp.rows[0].taxable === 20_000 && gp.rows[0].tax === 2400);
  const g = data<Gst>(await owner.get(`/reports/gst?month=${isoDay().slice(0, 7)}`));
  check('GST month: out ₹8.48 − in ₹24.00 = −₹15.52', g.outTax === 848 && g.inTax === 2400 && g.net === -1552, JSON.stringify({ o: g.outTax, i: g.inTax, n: g.net }));
  check('rate-wise purchase tax sits at 12%', g.rates.find((r) => r.rate === 12)?.purTax === 2400);

  section('4. B2B: the buyer’s GSTIN is copied onto the bill');
  const bill = data<{ buyerGstin: string | null; buyerName: string | null }>(await owner.get(`/sales/${data<{ id: string }>(b).id}`));
  check('bill carries Apollo Clinic · 19AAACA1234B1Z5', bill.buyerGstin === '19AAACA1234B1Z5' && bill.buyerName === 'Apollo Clinic', JSON.stringify(bill));
  check('walk-in bill has none', data<{ buyerGstin: string | null }>(await owner.get(`/sales/${data<{ id: string }>(a).id}`)).buyerGstin === null);
  check('GST month lists 1 B2B bill with that GSTIN', g.b2b.length === 1 && g.b2b[0]?.gstin === '19AAACA1234B1Z5' && g.b2b[0].taxable === 2411, JSON.stringify(g.b2b));

  section('5. Money and stock reports agree with their screens');
  check('expense report: ₹120', (await rep('expenses')).total?.amount === 12_000);
  const pnlRep = await rep('pnl');
  check('P&L report: net profit line = P&L', pnlRep.total?.amount === P.net && pnlRep.total.line === '= Net profit', JSON.stringify(pnlRep.total));
  const month = isoDay().slice(0, 7);
  const dbk = await rep('daybook', `month=${month}`);
  const dbApi = data<{ total: { net: number } }>(await owner.get(`/reports/daybook?month=${month}`));
  check('day book report total = day book', dbk.total?.net === dbApi.total.net);
  const batches = await BatchModel.find({ shopId: shop1, status: 'active', quantity: { $gt: 0 } }).lean();
  const soh = await rep('stock-on-hand', '');
  const val = await rep('valuation', '');
  const group = (ids: string[]) => {
    const mine = batches.filter((x) => ids.includes(String(x.productId)));
    return { cost: mine.reduce((s, x) => s + x.quantity * x.costPerBaseUnit, 0), mrp: mine.reduce((s, x) => s + Math.floor((x.mrp * x.quantity) / x.salePack + 0.5), 0) };
  };
  const tab = group([dolo, alprax]);
  const syr = group([syrup]);
  const vRow = (name: string) => val.rows.find((r) => r.category === name);
  check('valuation report: Tablet (Dolo + Alprax) and Syrup each = Σ their batches; nothing else', val.count === 2 && vRow('Tablet')?.cost === tab.cost && vRow('Tablet')?.mrp === tab.mrp && vRow('Syrup')?.cost === syr.cost && vRow('Syrup')?.mrp === syr.mrp && syr.cost > 0 && val.total?.cost === tab.cost + syr.cost, JSON.stringify(val.rows));
  check('stock on hand: cost total = Σ batch qty × cost', soh.total?.cost === batches.reduce((s, x) => s + x.quantity * x.costPerBaseUnit, 0) && soh.count === batches.length, String(soh.total?.cost));

  section('6. Exports');
  const x1 = await owner.raw('GET', `/reports/r/gst-sales/export?${range}&format=xlsx`);
  check('Excel → a spreadsheet', x1.status === 200 && (x1.headers.get('content-type') ?? '').includes('spreadsheetml'), String(x1.status));
  const x2 = await owner.raw('GET', `/reports/r/sales-register/export?${range}&format=pdf`);
  check('PDF → a PDF', x2.status === 200 && (x2.headers.get('content-type') ?? '').includes('pdf'), String(x2.status));
  check('accountant (reports: VX) exports; stock keeper (reports: V) → 403', (await accountant.raw('GET', `/reports/r/expenses/export?${range}&format=xlsx`)).status === 200 && (await keeper.raw('GET', `/reports/r/expenses/export?${range}&format=xlsx`)).status === 403);

  section('7. Analytics (S60) adds up');
  const an = async (tab: string, q = range) => data<Record<string, unknown>>(await owner.get(`/reports/analytics?tab=${tab}&${q}`));
  const sales = (await an('sales')) as { trend: { sales: number }[]; heatmap: { data: { y: number }[] }[]; weekday: { avg: number }[]; topProfit: { name: string; value: number }[] };
  check('sales tab: net sales ₹107 (137 − 30), 3 bills on the heatmap', sales.trend.reduce((x, d) => x + d.sales, 0) === 10_700 && sales.heatmap.flatMap((r) => r.data).reduce((x, c) => x + c.y, 0) === 3, JSON.stringify(sales.trend));
  check('weekday: today’s average is the day’s bills (₹137)', sales.weekday.some((w) => w.avg === 13_700));
  check('top by profit: Dolo (77.68 − 58.50 = ₹19.18) above Alprax (47.62 − 30.00 = ₹17.62)', sales.topProfit[0]?.name === 'Dolo 650 Tablet' && sales.topProfit[0].value === 1918 && sales.topProfit[1]?.value === 1762, JSON.stringify(sales.topProfit));
  const week = `from=${isoDay(-6)}&to=${isoDay()}`;
  const stock = (await an('stock', week)) as { valuation: { value: number }[]; purchaseVsSale: { purchases: number; cogs: number }[] };
  const atCost = (await BatchModel.find({ shopId: shop1, quantity: { $gt: 0 }, status: { $ne: 'returned' } }).lean()).reduce((x, b) => x + b.quantity * b.costPerBaseUnit, 0);
  check('valuation: today = Σ batches at cost; yesterday ₹0 (all stock came today)', stock.valuation.length === 7 && stock.valuation.at(-1)?.value === atCost && stock.valuation.at(-2)?.value === 0, JSON.stringify(stock.valuation.slice(-2)));
  check('purchase vs sale: ₹200 bought; cost of goods 19.50 × 3 + 30.00 − 19.50 = ₹69.00', stock.purchaseVsSale.reduce((x, w) => x + w.purchases, 0) === 20_000 && stock.purchaseVsSale.reduce((x, w) => x + w.cogs, 0) === 6900);
  const cust = (await an('customers')) as { growth: { fresh: number; repeat: number }[] };
  check('customers: 1 new (Apollo Clinic), 0 repeat', cust.growth.reduce((x, w) => x + w.fresh, 0) === 1 && cust.growth.reduce((x, w) => x + w.repeat, 0) === 0);
  const sups = (await an('suppliers')) as { bySupplier: { key: string; value: number }[]; rates: { name: string; before: number; now: number; pct: number }[] };
  // ₹20 a strip of 15 lands at 133 paise a tablet (rounded), so ₹19.95 a strip.
  check('suppliers: Sharma ₹224; Dolo’s rate ₹19.50 → ₹19.95 (+2.3%)', sups.bySupplier[0]?.value === 22_400 && sups.rates[0]?.name === 'Dolo 650 Tablet' && sups.rates[0].before === 1950 && sups.rates[0].now === 1995 && sups.rates[0].pct === 2.3, JSON.stringify(sups.rates));
  check('cashier → 403; bad tab → 422', (await cashier.get(`/reports/analytics?tab=sales&${range}`)).status === 403 && (await owner.get(`/reports/analytics?tab=money&${range}`)).status === 422);

  section('8. Another shop sees none of it');
  const other = await h.signIn('kakoli@rep2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Kakoli Pharmacy'))).id;
  check('sales register and GST empty', data<Report>(await other.get(`/reports/r/sales-register?${range}`)).count === 0 && data<Gst>(await other.get(`/reports/gst?month=${month}`)).outTax === 0);

  await h.close();
  finish();
}

main().catch(crash);
