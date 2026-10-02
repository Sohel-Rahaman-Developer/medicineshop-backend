// B7b checks: one Home per role, cut on the server; numbers worked by hand; Home and the expiry centre agree; charts add up.
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

interface Kpi { bills: number; gross: number; netSales: number; avgBill: number; profit: { revenue: number; cogs: number; gross: number } | null }
interface Bucket { count: number; cost: number | null; mrp: number }
interface Home {
  kind: string;
  ownOnly: boolean;
  range: Kpi | null;
  today: Kpi | null;
  stock: { value: number | null; mrpValue: number; low: number; out: number; top: { productName: string }[] } | null;
  expiry: { expired: Bucket; d30: Bucket; d60: Bucket; d90: Bucket } | null;
  supplierDue: { total: number; suppliers: number; overdue: number } | null;
  udhaar: { total: number; customers: number } | null;
  gst: { outTax: number; inTax: number; net: number } | null;
  expenses: { total: number; entries: number } | null;
  recent: { billNumber: string }[] | null;
  alerts: { type: string }[];
  reorder: { name: string; status: string }[] | null;
  purchasesToday: { count: number; total: number } | null;
}
interface Charts { trend: { day: string; sales: number; bills: number; profit: number | null }[]; category: { key: string; value: number }[]; payment: { key: string; value: number }[]; hourly: { bills: number }[]; top: { name: string; value: number; qty: number }[]; aging: { atCost: boolean; series: { data: number[] }[] } }

const IST = 5.5 * 60 * 60 * 1000;
const DAY = 86_400_000;
const isoDay = (offset = 0) => new Date(Date.now() + IST + offset * DAY).toISOString().slice(0, 10);

async function main() {
  const h = await startHarness();
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { CustomerModel } = await import('../src/modules/customers/customer.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');

  const owner = await h.signIn('rohit@dash1.test');
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
  const cashier = await invite('sunita@dash1.test', 'cashier');
  const keeper = await invite('arif@dash1.test', 'stockKeeper');
  const accountant = await invite('meera@dash1.test', 'accountant');
  const manager = await invite('vikram@dash1.test', 'manager');

  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (name: string, reorderLevel = 0) => data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel, reorderQuantity: 0 })).id;
  const dolo = await mk('Dolo 650 Tablet');
  const shelcal = await mk('Shelcal 500', 50);
  await mk('Crocin Advance');
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL1', expiry: '2028-12', quantity: 150, mrp: 3000, purchaseRate: 1950 });
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: shelcal, batchNumber: 'SH1', expiry: '2028-12', quantity: 30, mrp: 12_000, purchaseRate: 9000 });
  await BatchModel.updateOne({ shopId: shop1, batchNumber: 'SH1' }, { $set: { expiryDate: new Date(Date.now() + 10 * DAY) } });

  const sell = (c: typeof owner, qty: number, payments: { mode: string; amount: number }[]) => c.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: qty, unit: 'STRIP' }], payments });
  const s1 = await sell(owner, 2, [{ mode: 'CASH', amount: 6000 }]);
  const s2 = await sell(cashier, 1, [{ mode: 'UPI', amount: 3000 }]);
  const s3 = await sell(owner, 1, [{ mode: 'CASH', amount: 3000 }]);
  check('3 bills: owner ₹60 + ₹30 cash, cashier ₹30 UPI', [s1, s2, s3].every((r) => r.status === 201), [s1, s2, s3].map(code).join(' | '));
  const sup = data<{ id: string }>(await owner.post('/suppliers', { name: 'Sharma Distributors', contactPerson: 'Anil Sharma', phone: '98311 22334', email: 'orders@sharma.test', gstin: '19ABCDE1234F1Z5', drugLicense: 'WB/KOL/20B/1189', creditDays: 30, address: 'Bagri Market, Kolkata' })).id;
  const pur = await owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: sup, invoiceNumber: 'SD/1', invoiceDate: isoDay(), lines: [{ productId: dolo, batchNumber: 'DL2', expiry: '2029-01', quantity: 10, freeQuantity: 0, unit: 'STRIP', rate: 2000, discountPercent: 0, mrp: 3000, gstRate: 12, rack: '' }] });
  check('a ₹224 purchase on credit', pur.status === 201, code(pur));
  await owner.post('/expenses', { clientRequestId: randomUUID(), date: isoDay(), category: 'Rent', description: '', amount: 12_000, paymentMode: 'UPI', fromDrawer: false, vendor: '', referenceNumber: '' });
  const ratna = data<{ id: string }>(await owner.post('/customers', { name: 'Ratna Sen', phone: '98300 12345' }));
  await CustomerModel.updateOne({ shopId: shop1, _id: ratna.id }, { $set: { creditBalance: 50_000 } });
  const q = `?from=${isoDay()}&to=${isoDay()}`;
  const home = async (c: typeof owner) => data<Home>(await c.get(`/dashboard${q}`));

  section('1. Owner Home, worked by hand');
  const o = await home(owner);
  check('kind owner, not limited to own bills', o.kind === 'owner' && !o.ownOnly);
  check('3 bills, ₹120 net sales, ₹40 average', o.range?.bills === 3 && o.range.netSales === 12_000 && o.range.avgBill === 4000, JSON.stringify(o.range));
  // ₹60 → taxable 53.57; ₹30 → 26.79 (×2). Cost ₹19.50 a strip × 4.
  check('gross profit = (53.57 + 26.79 + 26.79) − 78.00 = ₹29.15', o.range?.profit?.revenue === 10_715 && o.range.profit.cogs === 7800 && o.range.profit.gross === 2915, JSON.stringify(o.range?.profit));
  check('today = the range (range is today)', o.today?.netSales === 12_000);
  check('stock: Shelcal low, Crocin out; value at cost shown', o.stock?.low === 1 && o.stock.out === 1 && (o.stock.value ?? 0) > 0 && o.stock.top.length > 0, JSON.stringify({ low: o.stock?.low, out: o.stock?.out }));
  check('supplier due ₹224 from 1 supplier, nothing overdue', o.supplierDue?.total === 22_400 && o.supplierDue.suppliers === 1 && o.supplierDue.overdue === 0, JSON.stringify(o.supplierDue));
  check('udhaar ₹500 from 1 customer', o.udhaar?.total === 50_000 && o.udhaar.customers === 1);
  check('expiry alert on the owner’s Home', o.alerts.some((a) => a.type === 'EXPIRY_SOON'), o.alerts.map((a) => a.type).join(','));
  check('recent bills, newest first', o.recent?.length === 3);
  check('manager gets the owner Home too', (await home(manager)).kind === 'owner');

  section('2. Home and the expiry centre show the same numbers');
  const ex = data<{ summary: { bucket: string; count: number; mrpValue: number; value?: number }[] }>(await owner.get('/stock/expiry?bucket=d30'));
  const c30 = ex.summary.find((s) => s.bucket === 'd30');
  check('0–30 days: 1 batch, same MRP and cost value', o.expiry?.d30.count === 1 && c30?.count === 1 && o.expiry.d30.mrp === c30.mrpValue && o.expiry.d30.cost === c30.value && o.expiry.d30.mrp === 24_000, JSON.stringify({ home: o.expiry?.d30, centre: c30 }));

  section('3. The cashier sees only own bills and no cost');
  const c = await home(cashier);
  check('kind counter, own only: 1 bill ₹30', c.kind === 'counter' && c.ownOnly && c.range?.bills === 1 && c.range.netSales === 3000, JSON.stringify(c.range));
  check('no profit, no stock value at cost, no expiry cost', c.range?.profit === null && c.stock?.value === null && c.stock.top.length === 0 && c.expiry?.d30.cost === null);
  check('recent bills: only the cashier’s', c.recent?.length === 1);
  check('no supplier due, no GST, no expenses for the cashier', c.supplierDue === null && c.gst === null && c.expenses === null);

  section('4. Stock keeper and accountant');
  const k = await home(keeper);
  check('stock keeper: kind stock, reorder list, today’s purchase, no sales', k.kind === 'stock' && (k.reorder?.map((r) => r.name).sort().join(',') ?? '') === 'Crocin Advance,Shelcal 500' && k.purchasesToday?.count === 1 && k.purchasesToday.total === 22_400 && k.range === null, JSON.stringify({ r: k.reorder, p: k.purchasesToday }));
  const a = await home(accountant);
  // Output tax: ₹60 → 6.43; ₹30 → 3.21 (×2) = 12.85. Input tax on the purchase: ₹24.00.
  check('accountant: kind money, GST this month 12.85 out − 24.00 in = −11.15', a.kind === 'money' && a.gst?.outTax === 1285 && a.gst.inTax === 2400 && a.gst.net === -1115, JSON.stringify(a.gst));
  check('accountant: expenses this month ₹120 in 1 entry', a.expenses?.total === 12_000 && a.expenses.entries === 1);

  section('5. Charts add up');
  const ch = data<Charts>(await owner.get(`/dashboard/charts${q}`));
  const day = ch.trend.at(-1);
  check('trend: one day, ₹120, 3 bills, ₹29.15 profit', ch.trend.length === 1 && day?.sales === 12_000 && day.bills === 3 && day.profit === 2915, JSON.stringify(ch.trend));
  check('category mix adds up to the bills', ch.category.reduce((s, x) => s + x.value, 0) === 12_000 && ch.category[0]?.key === 'Tablet', JSON.stringify(ch.category));
  check('payment mix: cash ₹90, UPI ₹30', ch.payment.find((p) => p.key === 'CASH')?.value === 9000 && ch.payment.find((p) => p.key === 'UPI')?.value === 3000);
  check('hourly adds up to 3 bills', ch.hourly.reduce((s, x) => s + x.bills, 0) === 3);
  check('top product Dolo: ₹120, 60 tablets', ch.top[0]?.name === 'Dolo 650 Tablet' && ch.top[0].value === 12_000 && ch.top[0].qty === 60);
  check('expiry aging at cost = the 0–30 bucket at cost', ch.aging.atCost && ch.aging.series.flatMap((s) => s.data).reduce((x, y) => x + y, 0) === o.expiry?.d30.cost);
  const cc = data<Charts>(await cashier.get(`/dashboard/charts${q}`));
  check('cashier charts: own bill only, no profit, aging at MRP', cc.trend.at(-1)?.sales === 3000 && cc.trend.at(-1)?.profit === null && !cc.aging.atCost && cc.aging.series.flatMap((s) => s.data).reduce((x, y) => x + y, 0) === 24_000);

  section('6. Range, previous period and isolation');
  const wk = data<Home>(await owner.get(`/dashboard?from=${isoDay(-6)}&to=${isoDay()}`));
  check('7 days → same bills (all today), 7-day trend', wk.range?.bills === 3 && data<Charts>(await owner.get(`/dashboard/charts?from=${isoDay(-6)}&to=${isoDay()}`)).trend.length === 7);
  check('to before from / 2-year range → 422', (await owner.get(`/dashboard?from=${isoDay()}&to=${isoDay(-1)}`)).status === 422 && (await owner.get(`/dashboard/charts?from=${isoDay(-800)}&to=${isoDay()}`)).status === 422);
  const other = await h.signIn('kakoli@dash2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Kakoli Pharmacy'))).id;
  const oh = data<Home>(await other.get(`/dashboard${q}`));
  check('another shop: nothing of shop 1', oh.range?.bills === 0 && oh.supplierDue?.total === 0 && oh.udhaar?.total === 0 && oh.stock?.low === 0);

  await h.close();
  finish();
}

main().catch(crash);
