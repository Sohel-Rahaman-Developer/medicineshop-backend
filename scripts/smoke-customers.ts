// B5a checks: customer master, udhaar (CREDIT) under a limit, collection oldest bill first, return against udhaar, cancel, doctors.
import { randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const details = (r: Res) => (r.json.error as { details?: Record<string, unknown> } | undefined)?.details ?? {};

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const units10 = { type: 'COUNT', base: 'CAPSULE', sale: 'STRIP', salePack: 10, purchase: 'STRIP', purchasePack: 1, allowLooseSale: true };

interface Cust { id: string; name: string; phone: string; creditBalance: number; creditLimit: number; totalSpend: number; visitCount: number; firstVisit: string | null; version: number; status: string }
interface Sale { id: string; dueAmount?: number; paymentStatus?: string; customerId: string | null; customerName: string; doctorName: string; status: string }
interface Ledger { rows: { kind: string; debit: number; credit: number; balance: number }[]; balance: number }

async function main() {
  const h = await startHarness();
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { fyOf } = await import('../src/utils/fy.js');
  const fy = fyOf(new Date());

  const owner = await h.signIn('rohit@cust1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (name: string, units: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0, ...over })).id;
  const dolo = await mk('Dolo 650 Tablet', units15);
  const amox = await mk('Augmentin 625', units10);
  const alprax = await mk('Alprax 0.25', units15, { scheduleType: 'H1' });
  for (const [productId, b, q, mrp] of [[dolo, 'DL1', 300, 3000], [amox, 'AM1', 200, 9200], [alprax, 'AL1', 60, 4500]] as const) {
    await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId, batchNumber: b, expiry: '2028-12', quantity: q, mrp, purchaseRate: Math.round(mrp * 0.65) });
  }
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    const inv = data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? '';
    await c.post(`/invitations/${inv}/accept`, { name: email.split('@')[0] });
    c.shopId = shop1;
    return c;
  };
  const cashier = await invite('sunita@cust1.test', 'cashier');
  const accountant = await invite('meera@cust1.test', 'accountant');
  const bill = (items: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), items, payments: [], ...over });
  const credit = (amount: number) => [{ mode: 'CREDIT', amount }];
  const cust = async (id: string) => data<Cust>(await owner.get(`/customers/${id}`));

  section('1. Customer master');
  const r1 = await cashier.post('/customers', { name: 'Ratna Sen', phone: '98300 12345' });
  const ratna = data<Cust>(r1);
  check('cashier adds Ratna Sen · phone kept as +91…', r1.status === 201 && ratna.phone === '+919830012345', code(r1));
  const dup = await owner.post('/customers', { name: 'R. Sen', phone: '9830012345' });
  check('the same phone again → 409 naming who has it', dup.status === 409 && details(dup).id === ratna.id && details(dup).name === 'Ratna Sen', code(dup));
  check('no phone → 422 · a landline-looking number → 422', (await owner.post('/customers', { name: 'No Phone' })).status === 422 && (await owner.post('/customers', { name: 'Bad', phone: '12345' })).status === 422);
  check('accountant (customers: view, export) can’t add → 403', (await accountant.post('/customers', { name: 'X Y', phone: '98300 55555' })).status === 403);
  check('find by name and by the last digits of the phone', data<Cust[]>(await owner.get('/customers?q=ratna')).length === 1 && data<Cust[]>(await owner.get('/customers?q=12345'))[0]?.id === ratna.id);
  const up = await owner.put(`/customers/${ratna.id}`, { name: 'Ratna Sen', phone: '98300 12345', creditLimit: 50_000, version: ratna.version });
  check('owner sets a ₹500 udhaar limit', up.status === 200 && data<Cust>(up).creditLimit === 50_000, code(up));
  check('an old version → 409', (await owner.put(`/customers/${ratna.id}`, { name: 'Ratna', phone: '98300 12345', version: ratna.version })).status === 409);
  check('audit: limit ₹0 → ₹500', (await AuditLogModel.countDocuments({ shopId: shop1, entityId: ratna.id, text: /udhaar limit ₹0.00 → ₹500.00/ })) === 1);

  section('2. Udhaar on a bill');
  const amit = data<Cust>(await owner.post('/customers', { name: 'Amit Das', phone: '98310 22222' }));
  check('udhaar without a customer → 422', (await owner.post('/sales', bill([{ productId: dolo, quantity: 2, unit: 'STRIP' }], { payments: credit(6000) }))).status === 422);
  check('a customer with no limit → 422', (await owner.post('/sales', bill([{ productId: dolo, quantity: 2, unit: 'STRIP' }], { customerId: amit.id, payments: credit(6000) }))).status === 422);
  const b1r = await owner.post('/sales', bill([{ productId: dolo, quantity: 2, unit: 'STRIP' }, { productId: amox, quantity: 1, unit: 'STRIP' }], { customerId: ratna.id, payments: credit(15_200) }));
  const b1 = data<{ id: string; billNumber: string }>(b1r);
  const s1 = data<Sale>(await owner.get(`/sales/${b1.id}`));
  check('₹152 all on udhaar → bill due ₹152, status credit, name from the customer', b1r.status === 201 && s1.customerId === ratna.id && s1.customerName === 'Ratna Sen', code(b1r));
  const s1db = await SaleModel.findOne({ shopId: shop1, _id: b1.id }).lean();
  check('sale: dueAmount ₹152 · paymentStatus credit', s1db?.dueAmount === 15_200 && s1db.paymentStatus === 'credit');
  let rc = await cust(ratna.id);
  check('Ratna: udhaar ₹152 · spend ₹152 · 1 visit · first visit set', rc.creditBalance === 15_200 && rc.totalSpend === 15_200 && rc.visitCount === 1 && rc.firstVisit !== null);
  const b2 = data<{ id: string }>(await owner.post('/sales', bill([{ productId: amox, quantity: 1, unit: 'STRIP' }], { customerId: ratna.id, payments: [{ mode: 'CASH', amount: 4800 }, { mode: 'CREDIT', amount: 4400 }] })));
  const s2db = await SaleModel.findOne({ shopId: shop1, _id: b2.id }).lean();
  check('split ₹48 cash + ₹44 udhaar → partial, due ₹44', s2db?.dueAmount === 4400 && s2db.paymentStatus === 'partial' && s2db.paymentMode === 'SPLIT');
  const over = await owner.post('/sales', bill([{ productId: amox, quantity: 4, unit: 'STRIP' }], { customerId: ratna.id, payments: credit(36_800) }));
  check('₹196 owed + ₹368 > ₹500 limit → 409 OVER_LIMIT', over.status === 409 && details(over).reason === 'OVER_LIMIT' && details(over).balance === 19_600, code(over));
  // ₹196 owed, ₹304 room: two ₹276 bills at once — only one fits.
  const race = await Promise.all([1, 2].map(() => owner.post('/sales', bill([{ productId: amox, quantity: 3, unit: 'STRIP' }], { customerId: ratna.id, payments: credit(27_600) }))));
  check('two udhaar bills for the last of the limit at once → one 201, one 409', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 1, race.map(code).join(' | '));
  const b3 = data<{ id: string }>(race.find((r) => r.status === 201) ?? race[0] ?? ({} as Res));
  rc = await cust(ratna.id);
  check('udhaar ₹472, never over ₹500', rc.creditBalance === 47_200);

  section('3. Collect — oldest bill first');
  check('more than owed → 422', (await cashier.post(`/customers/${ratna.id}/payments`, { clientRequestId: randomUUID(), amount: 50_000, mode: 'CASH' })).status === 422);
  const cb = { clientRequestId: randomUUID(), amount: 17_000, mode: 'CASH' };
  const cr = await cashier.post(`/customers/${ratna.id}/payments`, cb);
  const pay = data<{ receiptNumber: string; balanceAfter: number; applied: { billNumber: string; amount: number }[] }>(cr);
  check(`cashier collects ₹170 → RCPT-${fy}-0001 · ₹152 clears the first bill, ₹18 to the second`, cr.status === 201 && pay.receiptNumber === `RCPT-${fy}-0001` && pay.applied[0]?.amount === 15_200 && pay.applied[1]?.amount === 1800 && pay.balanceAfter === 30_200, code(cr));
  check('same clientRequestId → 200, collected once', (await cashier.post(`/customers/${ratna.id}/payments`, cb)).status === 200 && (await cust(ratna.id)).creditBalance === 30_200);
  const s1after = await SaleModel.findOne({ shopId: shop1, _id: b1.id }).lean();
  check('first bill: due 0, paid', s1after?.dueAmount === 0 && s1after.paymentStatus === 'paid');
  check('accountant can’t collect (no customers: edit) → 403', (await accountant.post(`/customers/${ratna.id}/payments`, { clientRequestId: randomUUID(), amount: 100, mode: 'CASH' })).status === 403);

  section('4. Return against udhaar, cancel');
  const ret = await owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: b2.id, items: [{ line: 0, quantity: 10, reason: 'Doctor changed the prescription' }], refundMode: 'ADJUST_CREDIT' });
  const rd = data<{ adjusted: number; cashBack: number; total: number }>(ret);
  check('return ₹92 on a bill with ₹26 udhaar left → ₹26 off udhaar, ₹66 cash back', ret.status === 201 && rd.total === 9200 && rd.adjusted === 2600 && rd.cashBack === 6600, code(ret));
  check('against udhaar on a bill with none left → 422', (await owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: b1.id, items: [{ line: 0, quantity: 1, reason: 'Customer returned' }], refundMode: 'ADJUST_CREDIT' })).status === 422);
  rc = await cust(ratna.id);
  check('udhaar ₹302 − ₹26 = ₹276 · spend down by ₹92', rc.creditBalance === 27_600 && rc.totalSpend === 15_200 + 9200 + 27_600 - 9200);
  const cn = await owner.post(`/sales/${b3.id}/cancel`, { reason: 'Customer changed mind' });
  rc = await cust(ratna.id);
  check('cancel the ₹276 udhaar bill → udhaar 0, one visit less', cn.status === 200 && rc.creditBalance === 0 && rc.visitCount === 2, code(cn));
  const led = data<Ledger>(await owner.get(`/customers/${ratna.id}/ledger`));
  check('statement: 3 bills, a payment, a return, a cancel — running balance ends at ₹0 = the customer’s udhaar', led.rows.length === 6 && led.rows.at(-1)?.balance === 0 && led.balance === 0, JSON.stringify(led.rows.map((r) => [r.kind, r.debit, r.credit, r.balance])));
  check('bills of a customer', data<Sale[]>(await owner.get(`/sales?customerId=${ratna.id}`)).length === 3);
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const dc = data<{ cash: { collected: number; udhaar: number; refunds: number } }>(await owner.get(`/day-close?day=${today}`)).cash;
  check('day close: ₹170 collected in cash · ₹472 given on udhaar · ₹66 cash back', dc.collected === 17_000 && dc.udhaar === 15_200 + 4400 + 27_600 && dc.refunds === 6600, JSON.stringify(dc));

  section('5. Doctors, blocked, other shop');
  const d1 = await owner.post('/doctors', { name: 'Dr. S. Banerjee', specialization: 'Physician', registrationNumber: 'WBMC 4471' });
  const doc = data<{ id: string }>(d1);
  check('add a doctor · the same name again → 422', d1.status === 201 && (await owner.post('/doctors', { name: 'dr. s. banerjee' })).status === 422);
  check('cashier reads the list at the counter', data<unknown[]>(await cashier.get('/doctors')).length === 1);
  const h1 = await owner.post('/sales', bill([{ productId: alprax, quantity: 1, unit: 'STRIP' }], { payments: [{ mode: 'CASH', amount: 4500 }], rx: { doctorId: doc.id, patientName: 'Amit Das' } }));
  check('H1 bill with a listed doctor → the doctor’s name on the bill', h1.status === 201 && data<Sale>(await owner.get(`/sales/${data<{ id: string }>(h1).id}`)).doctorName === 'Dr. S. Banerjee', code(h1));
  const fresh = data<Cust>(await owner.get(`/customers/${amit.id}`));
  await owner.put(`/customers/${amit.id}`, { name: 'Amit Das', phone: '98310 22222', status: 'blocked', version: fresh.version });
  check('a blocked customer on a bill → 409', (await owner.post('/sales', bill([{ productId: dolo, quantity: 1, unit: 'STRIP' }], { customerId: amit.id, payments: [{ mode: 'CASH', amount: 3000 }] }))).status === 409);
  const other = await h.signIn('owner@cust2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Other Pharmacy'))).id;
  const cats2 = data<{ id: string; name: string }[]>(await other.get('/categories'));
  const own = data<{ id: string }>(await other.post('/products', { name: 'Clonotril 0.5', company: 'Torrent', salt: 'Clonazepam', strength: '', categoryId: cats2.find((c) => c.name === 'Tablet')?.id, scheduleType: 'H1', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  await other.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: own, batchNumber: 'CL1', expiry: '2028-12', quantity: 30, mrp: 6000, purchaseRate: 4000 });
  // Shop 2's own product, so a 422 below can only come from shop 1's customer or doctor.
  const mine = [{ productId: own, quantity: 1, unit: 'STRIP' }];
  check('shop 2: shop 1 customer → 404 · its statement → 404 · collect → 404', (await other.get(`/customers/${ratna.id}`)).status === 404 && (await other.get(`/customers/${ratna.id}/ledger`)).status === 404 && (await other.post(`/customers/${ratna.id}/payments`, { clientRequestId: randomUUID(), amount: 100, mode: 'CASH' })).status === 404);
  check('shop 2: no customers listed · shop 1 doctor on an H1 bill → 422', data<unknown[]>(await other.get('/customers')).length === 0 && (await other.post('/sales', bill(mine, { payments: [{ mode: 'CASH', amount: 6000 }], rx: { doctorId: doc.id, patientName: 'X' } }))).status === 422);
  check('shop 2: shop 1 customer on a bill → 422', (await other.post('/sales', bill(mine, { customerId: ratna.id, payments: [{ mode: 'CASH', amount: 6000 }], rx: { doctorName: 'Dr. X', patientName: 'X' } }))).status === 422);

  await h.close();
  finish();
}

main().catch(crash);
