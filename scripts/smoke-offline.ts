// D104 checks: offline billing — a counter's own series, the catalog it keeps, bills arriving later exactly once,
// dated when sold, never refused for stock or a sum the cashier can't change now, and the owner told what to check.
import { randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/OFL20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const istDay = (at: number) => new Date(at + 5.5 * HOUR).toISOString().slice(0, 10);

interface Device { id: string; code: string; fy: string; seq: number }
interface CatItem { id: string; name: string; sellable: number; codes: string[]; batches: { mrp: number; quantity: number }[] }
interface Saved { id: string; billNumber: string; grandTotal: number; offline: { short: { name: string; quantity: string }[]; afterClose: boolean; paidDiff: number } | null }
interface Line { batchNumber: string; quantityInBase: number; typedPrice: boolean; stockShort?: boolean; totalAmount: number; lineDiscount: number }
interface Detail { billNumber: string; billDate: string; lines: Line[]; grandTotal: number; paidAmount: number }

async function main() {
  const h = await startHarness();
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { NotificationModel } = await import('../src/modules/notifications/notification.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { fyOf } = await import('../src/utils/fy.js');
  const fy = fyOf(new Date());

  const owner = await h.signIn('rohit@offline1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Offline Pharmacy'))).id;
  owner.shopId = shopId;
  await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 10 } });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'sunita@offline1.test', name: 'Sunita', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('sunita@offline1.test');
  await cashier.post(`/invitations/${data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Sunita' });
  cashier.shopId = shopId;
  const other = await h.signIn('mina@offline2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Other Medical'))).id;

  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id ?? '';
  const mk = async (name: string, barcode = '') => data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0, barcode })).id;
  const dolo = await mk('Dolo 650 Tablet', '8901234567890');
  const pan = await mk('Pan 40');
  const never = await mk('Shelcal 500');
  for (const [p, b, qty] of [[dolo, 'DL1', 450], [pan, 'PN1', 15]] as const) await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId: p, batchNumber: b, expiry: '2028-12', quantity: qty, mrp: 3350, purchaseRate: 2000 });

  section('1. A counter registers once');
  const key = randomUUID();
  const reg = await cashier.post('/pos/offline/device', { key, name: 'Counter 1' });
  const dev = data<Device>(reg);
  check('a cashier registers this browser → its own code OFL1, nothing used yet', reg.status === 200 && dev.code === 'OFL1' && dev.seq === 0 && dev.fy === fy, code(reg));
  check('the same browser again → the same code', data<Device>(await cashier.post('/pos/offline/device', { key, name: 'Counter 1' })).id === dev.id);
  const dev2 = data<Device>(await owner.post('/pos/offline/device', { key: randomUUID(), name: 'Owner laptop' }));
  check('another browser → the next code, OFL2', dev2.code === 'OFL2');
  check('no device key → 422', (await cashier.post('/pos/offline/device', { name: 'x' })).status === 422);

  section('2. The copy it keeps');
  const cat = data<{ at: string; settings: { roundOff: boolean }; items: CatItem[] }>(await cashier.get('/pos/offline/catalog'));
  const cd = cat.items.find((i) => i.id === dolo);
  check('every active product, with its barcodes, sellable stock and batches; the pricing settings too', cat.items.length === 3 && cd?.codes.includes('8901234567890') === true && cd.sellable === 450 && cd.batches[0]?.mrp === 3350 && typeof cat.settings.roundOff === 'boolean');
  check('a product never stocked is in it, with nothing to sell', cat.items.find((i) => i.id === never)?.sellable === 0);

  section('3. A bill sent later');
  const soldAt = new Date(Date.now() - 2 * HOUR).toISOString();
  const bill = (over: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), deviceId: dev.id, seq: 1, soldAt, items: [{ productId: dolo, quantity: 2, unit: 'STRIP', price: 6700 }], payments: [{ mode: 'CASH', amount: 6700 }], ...over });
  const first = bill();
  const r1 = await cashier.post('/pos/offline/sales', first);
  const s1 = data<Saved>(r1);
  check(`saved on the counter's series: OFL1-${fy}-0001`, r1.status === 201 && s1.billNumber === `OFL1-${fy}-0001` && s1.grandTotal === 6700, code(r1));
  const d1 = data<Detail>(await owner.get(`/sales/${s1.id}`));
  check('dated when it was sold, not when it arrived', Math.abs(new Date(d1.billDate).getTime() - new Date(soldAt).getTime()) < 1000);
  check('at MRP: not a typed price', d1.lines.every((l) => !l.typedPrice));
  check('stock went down by 2 strips', (await BatchModel.findOne({ shopId, batchNumber: 'DL1' }).lean())?.quantity === 420);
  check('nothing to check: no alert', s1.offline?.short.length === 0 && !s1.offline.afterClose && s1.offline.paidDiff === 0 && (await NotificationModel.countDocuments({ shopId, type: 'OFFLINE_SYNC' })) === 0);
  const again = await cashier.post('/pos/offline/sales', first);
  check('sent again (the line dropped mid-way) → the same bill, 200, stock untouched', again.status === 200 && data<Saved>(again).billNumber === s1.billNumber && (await BatchModel.findOne({ shopId, batchNumber: 'DL1' }).lean())?.quantity === 420 && (await SaleModel.countDocuments({ shopId })) === 1);
  const clash = await cashier.post('/pos/offline/sales', bill());
  check('another bill on a number already used → 409 NUMBER_USED, nothing saved', clash.status === 409 && (clash.json.error?.details as { reason?: string } | undefined)?.reason === 'NUMBER_USED' && (await SaleModel.countDocuments({ shopId })) === 1, code(clash));
  check('the counter remembers its last number: registering again says 1', data<Device>(await cashier.post('/pos/offline/device', { key, name: 'Counter 1' })).seq === 1);

  section('4. Sold more than the system had');
  // 3 × ₹33.50 = ₹100.50, rounded to ₹101 — what the counter showed and took.
  const short = await cashier.post('/pos/offline/sales', bill({ seq: 2, items: [{ productId: pan, quantity: 3, unit: 'STRIP', price: 10_050 }], payments: [{ mode: 'UPI', amount: 10_100 }] }));
  const s2 = data<Saved>(short);
  check('saved all the same — the medicine is already with the customer', short.status === 201 && s2.grandTotal === 10_100 && s2.offline?.paidDiff === 0, code(short));
  const d2 = data<Detail>(await owner.get(`/sales/${s2.id}`));
  check('1 strip from stock, 2 strips marked short (no stock taken)', d2.lines.length === 2 && d2.lines[0]?.quantityInBase === 15 && !d2.lines[0].stockShort && d2.lines[1]?.quantityInBase === 30 && d2.lines[1].stockShort === true);
  check('the batch is at 0, never below', (await BatchModel.findOne({ shopId, batchNumber: 'PN1' }).lean())?.quantity === 0);
  const alert = await NotificationModel.findOne({ shopId, key: `OFFLINE_SYNC:${s2.billNumber}` }).lean();
  check('the owner is told what to count', alert?.priority === 'high' && /Pan 40: 2 strips more than the system had/.test(alert.body), alert?.body);
  check('…and the reply says so', s2.offline?.short[0]?.quantity === '2 strips');
  const none = await cashier.post('/pos/offline/sales', bill({ seq: 3, items: [{ productId: never, quantity: 1, unit: 'STRIP', price: 1000 }], payments: [{ mode: 'CASH', amount: 1000 }] }));
  check('a product that never had stock → 422, kept on the counter to send after stock is added', none.status === 422 && /never had stock/.test(none.json.error?.message ?? ''), code(none));
  const online = await cashier.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: pan, quantity: 1, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: 3350 }] });
  check('online billing still refuses what isn’t there (409 SHORT)', online.status === 409, code(online));

  section('5. The sum charged');
  const cheap = data<Saved>(await cashier.post('/pos/offline/sales', bill({ seq: 4, items: [{ productId: dolo, quantity: 1, unit: 'STRIP', price: 3000 }], payments: [{ mode: 'CASH', amount: 3000 }] })));
  const d4 = data<Detail>(await owner.get(`/sales/${cheap.id}`));
  check('a lower price typed offline: kept, as a discount', d4.grandTotal === 3000 && d4.lines[0]?.typedPrice === true && d4.lines[0].lineDiscount === 350);
  const less = data<Saved>(await cashier.post('/pos/offline/sales', bill({ seq: 5, items: [{ productId: dolo, quantity: 1, unit: 'STRIP', price: 3000 }], payments: [{ mode: 'CASH', amount: 2950 }] })));
  check('paid ₹0.50 less than the bill: saved with the gap, the owner told', less.offline?.paidDiff === -50 && /paid ₹29.50 for a ₹30.00 bill \(less by ₹0.50\)/.test((await NotificationModel.findOne({ shopId, key: `OFFLINE_SYNC:${less.billNumber}` }).lean())?.body ?? ''));
  check('udhaar can’t come offline → 422', (await cashier.post('/pos/offline/sales', bill({ seq: 6, payments: [{ mode: 'CREDIT', amount: 6700 }] }))).status === 422);

  section('6. Dates');
  check('dated in the future → 422', (await cashier.post('/pos/offline/sales', bill({ seq: 6, soldAt: new Date(Date.now() + HOUR).toISOString() }))).status === 422);
  check('older than 60 days → 422', (await cashier.post('/pos/offline/sales', bill({ seq: 6, soldAt: new Date(Date.now() - 61 * DAY).toISOString() }))).status === 422);
  const today = istDay(Date.now());
  const st = data<{ cash: { expected: number } | null }>(await owner.get('/day-close'));
  const closed = await owner.post('/day-close', { day: today, counted: st.cash?.expected ?? 0, takenOut: 0 });
  check('the owner closes today', closed.status === 201, code(closed));
  const late = data<Saved>(await cashier.post('/pos/offline/sales', bill({ seq: 6, soldAt: new Date(Date.now() - 5 * 60_000).toISOString(), payments: [{ mode: 'CASH', amount: 6700 }] })));
  check('a bill of today arriving after the close: saved, marked, the owner told the count missed its cash', late.offline?.afterClose === true && /already closed — its cash was not in that day’s count/.test((await NotificationModel.findOne({ shopId, key: `OFFLINE_SYNC:${late.billNumber}` }).lean())?.body ?? ''));

  section('7. Who and where');
  await owner.post(`/products/${pan}/active`, { isActive: false, version: 0 });
  const off = await cashier.post('/pos/offline/sales', bill({ seq: 7, items: [{ productId: dolo, quantity: 1, unit: 'STRIP', price: 3350 }], payments: [{ mode: 'CARD', amount: 3350 }] }));
  check('card works offline', off.status === 201, code(off));
  check("another shop's counter id → 404", (await other.post('/pos/offline/sales', bill({ seq: 1 }))).status === 404);
  check("…and it can't read this shop's catalog", data<{ items: CatItem[] }>(await other.get('/pos/offline/catalog')).items.length === 0);
  check('no session → 401', (await h.client().post('/pos/offline/sales', bill({ seq: 9 }))).status === 401);
  check('the bills list shows the offline numbers with the rest', (await SaleModel.countDocuments({ shopId, 'offline.device': 'OFL1' })) === 6);

  finish();
}

main().catch(crash);
