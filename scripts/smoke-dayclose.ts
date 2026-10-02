// B4c day close checks (PLAN §35.3): every kind of cash in and out on one day, worked out by hand below.
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
const DAY = 86_400_000;
const istDay = (at: number) => new Date(at + 5.5 * 3600_000).toISOString().slice(0, 10);

interface Cash { day: string; opening: number; openingFrom: string | null; cashSales: number; advances: number; refunds: number; orderRefunds: number; advanceBack: number; cancelled: number; suppliers: number; cashIn: number; cashOut: number; expected: number; upi: number; card: number; advanceUsed: number; bills: number; byUser: { name: string; cash: number }[] }
interface Status { day: string; today: string; isToday: boolean; lastClosed: string | null; closed: { counted: number; diff: number; leftInDrawer: number; takenOut: number } | null; cash: Cash | null }

async function main() {
  const h = await startHarness();
  const { ShopModel } = await import('../src/modules/shops/shop.model.js');
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { DayCloseModel } = await import('../src/modules/dayclose/dayclose.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const today = istDay(Date.now());
  const yesterday = istDay(Date.now() - DAY);

  const setup = async (email: string, name: string) => {
    const c = await h.signIn(email);
    c.shopId = data<{ id: string }>(await c.post('/shops', shopBody(name))).id;
    const cats = data<{ id: string; name: string }[]>(await c.get('/categories'));
    const mk = async (pname: string, units: Record<string, unknown>) =>
      data<{ id: string }>(await c.post('/products', { name: pname, company: 'Micro Labs', salt: pname, strength: '', categoryId: cats.find((x) => x.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
    const dolo = await mk('Dolo 650 Tablet', units15);
    const amox = await mk('Augmentin 625', units10);
    await c.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL1', expiry: '2028-12', quantity: 300, mrp: 3000, purchaseRate: 1900 });
    await c.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: amox, batchNumber: 'AM1', expiry: '2028-12', quantity: 100, mrp: 9200, purchaseRate: 6400 });
    return { c, dolo, amox };
  };
  const bill = (items: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), items, payments: [], ...over });
  const cash = (amount: number) => [{ mode: 'CASH', amount }];
  const ok = async (what: string, p: Promise<Res>) => {
    const r = await p;
    if (r.status !== 200 && r.status !== 201) throw new Error(`${what}: ${code(r)}`);
    return r;
  };

  section('1. One day of cash, worked out by hand');
  const { c: owner, dolo, amox } = await setup('rohit@close1.test', 'Shri Ram Medical Store');
  const shop1 = owner.shopId ?? '';
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  await ShopModel.updateOne({ _id: shop1 }, { $set: { 'settings.billing.openingFloat': 200_000 } });
  const a = data<{ id: string }>(await ok('bill A', owner.post('/sales', bill([{ productId: dolo, quantity: 2, unit: 'STRIP' }, { productId: amox, quantity: 1, unit: 'STRIP' }], { payments: cash(15_200), cashReceived: 20_000 }))));
  await ok('bill B', owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { payments: [{ mode: 'UPI', amount: 9200 }] })));
  const cbill = data<{ id: string }>(await ok('bill C', owner.post('/sales', bill([{ productId: dolo, quantity: 1, unit: 'STRIP' }], { payments: cash(3000) }))));
  await ok('cancel C', owner.post(`/sales/${cbill.id}/cancel`, { reason: 'Wrong item' }));
  await ok('return', owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: a.id, items: [{ line: 0, quantity: 7, reason: 'Bought extra' }], refundMode: 'CASH' }));
  const order = (advance: number, advanceMode: string, productId = dolo) => ok('order', owner.post('/orders', { clientRequestId: randomUUID(), customer: { name: 'Customer' }, items: [{ productId, qty: 1 }], advance, advanceMode }));
  await order(10_000, 'CASH');
  await order(5000, 'UPI');
  const o3 = data<{ id: string }>(await order(5000, 'CASH'));
  await ok('order refund', owner.post(`/orders/${o3.id}/cancel`, { reason: 'Never came', refundMode: 'CASH' }));
  const o4 = data<{ id: string }>(await order(50_000, 'CASH', amox));
  await ok('bill the order', owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { orderId: o4.id })));
  const sup = data<{ id: string }>(await ok('supplier', owner.post('/suppliers', { name: 'Sharma Distributors', contactPerson: '', phone: '98311 22334', email: '', gstin: '', drugLicense: '', creditDays: 30, address: '' }))).id;
  await ok('pay from the drawer', owner.post(`/suppliers/${sup}/payments`, { clientRequestId: randomUUID(), amount: 30_000, mode: 'CASH', reference: '', fromDrawer: true }));
  await ok('pay from the owner’s pocket', owner.post(`/suppliers/${sup}/payments`, { clientRequestId: randomUUID(), amount: 100_000, mode: 'CASH', reference: '', fromDrawer: false }));

  const st = data<Status>(await owner.get('/day-close'));
  const x = st.cash;
  check('today, not closed, nothing closed before', st.day === today && st.isToday && st.closed === null && st.lastClosed === null && x !== null);
  check('opening = the shop’s float ₹2,000', x?.opening === 200_000 && x.openingFrom === null);
  check('cash bills ₹152 + ₹30 = ₹182 (the cancelled one too — it was paid)', x?.cashSales === 18_200);
  check('cash advances ₹100 + ₹50 + ₹500 (UPI advance left out)', x?.advances === 65_000);
  check('out: return ₹14 · advance refund ₹50 · advance back on a bill ₹408 · cancelled ₹30 · supplier ₹300 (not the ₹1,000 from the owner)', x?.refunds === 1400 && x.orderRefunds === 5000 && x.advanceBack === 40_800 && x.cancelled === 3000 && x.suppliers === 30_000, JSON.stringify(x));
  check('expected = 2,000 + 832 − 802 = ₹2,030', x?.cashIn === 83_200 && x.cashOut === 80_200 && x.expected === 203_000, String(x?.expected));
  check('apart: UPI ₹92 · card ₹0 · advance used ₹92 · 4 bills', x?.upi === 9200 && x.card === 0 && x.advanceUsed === 9200 && x.bills === 4);
  check('cash by person: Rohit ₹182', x?.byUser.length === 1 && x.byUser[0]?.cash === 18_200);

  section('2. Close');
  check('taking out more than counted → 422', (await owner.post('/day-close', { day: today, counted: 1000, takenOut: 2000 })).status === 422);
  check('a future day → 422', (await owner.post('/day-close', { day: istDay(Date.now() + 2 * DAY), counted: 1000 })).status === 422);
  check('short by ₹10 without a note → 422', (await owner.post('/day-close', { day: today, counted: 202_000, takenOut: 0 })).status === 422);
  const cl = await owner.post('/day-close', { day: today, counted: 203_000, takenOut: 150_000, denoms: { '50000': 4 } });
  const cd = data<{ diff: number; leftInDrawer: number; expected: number }>(cl);
  check('counted ₹2,030 = expected → matched · ₹1,500 out · ₹530 left for tomorrow', cl.status === 201 && cd.diff === 0 && cd.leftInDrawer === 53_000 && cd.expected === 203_000, code(cl));
  check('close again → 409', (await owner.post('/day-close', { day: today, counted: 203_000 })).status === 409);
  check('yesterday after today is closed → 409', (await owner.post('/day-close', { day: yesterday, counted: 0 })).status === 409);
  const after = data<Status>(await owner.get('/day-close'));
  check('status shows the close and no open maths', after.closed?.counted === 203_000 && after.cash === null && after.lastClosed === today);
  check('audit: “closed … matched”', (await AuditLogModel.countDocuments({ shopId: shop1, entityName: `Day close ${today}`, text: /matched/ })) === 1);
  check('history has it', data<unknown[]>(await owner.get('/day-close/history')).length === 1);

  section('3. Yesterday first, opening from the last close, a short day');
  const { c: owner2, dolo: d2 } = await setup('owner@close2.test', 'Other Pharmacy');
  const shop2 = owner2.shopId ?? '';
  const y = data<{ id: string }>(await ok('bill', owner2.post('/sales', bill([{ productId: d2, quantity: 1, unit: 'STRIP' }], { payments: cash(3000) }))));
  await SaleModel.updateOne({ shopId: shop2, _id: y.id }, { $set: { billDate: new Date(Date.now() - DAY) } });
  const s2 = data<Status>(await owner2.get('/day-close'));
  check('yesterday had bills and no close → yesterday comes first', s2.day === yesterday && !s2.isToday && s2.cash?.cashSales === 3000, JSON.stringify({ d: s2.day, c: s2.cash?.cashSales }));
  check('shop 2 sees only its own cash', s2.cash?.cashSales === 3000 && s2.cash.advances === 0);
  await ok('close yesterday short', owner2.post('/day-close', { day: yesterday, counted: 2000, takenOut: 0, note: 'Gave change twice' }));
  const y2 = await DayCloseModel.findOne({ shopId: shop2, day: yesterday }).lean();
  check('yesterday: short ₹10 with the note, ₹20 left in the drawer', y2?.diff === -1000 && y2.leftInDrawer === 2000 && y2.note === 'Gave change twice');
  const t2 = data<Status>(await owner2.get('/day-close'));
  check('today: opening = what yesterday left (₹20)', t2.day === today && t2.cash?.opening === 2000 && t2.cash.openingFrom === yesterday);

  section('4. Who');
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    const inv = data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? '';
    await c.post(`/invitations/${inv}/accept`, { name: email.split('@')[0] });
    c.shopId = shop1;
    return c;
  };
  const cashier = await invite('sunita@close1.test', 'cashier');
  const accountant = await invite('meera@close1.test', 'accountant');
  check('cashier (counter) sees the day close', (await cashier.get('/day-close')).status === 200);
  check('accountant (no POS) → 403', (await accountant.get('/day-close')).status === 403 && (await accountant.post('/day-close', { day: today, counted: 0 })).status === 403);
  check('unknown field → 422', (await owner2.post('/day-close', { day: today, counted: 0, expected: 0 })).status === 422);

  await h.close();
  finish();
}

main().catch(crash);
