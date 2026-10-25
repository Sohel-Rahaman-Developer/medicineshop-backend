// D103 checks: refills due — regular customers found by rule from the shop's own bills (no AI), reminded by WhatsApp or
// a call, quiet for a week after, gone once they buy, "not a regular" with undo, and the brief counting them.
import { randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

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
const DAY = 86_400_000;

interface Row { customerId: string; name: string; product: string; every: number; buys: number; late: number; lastPacks: number; inStock: boolean; reminded: { by: string; how: string } | null }
interface Due { due: number; reminded: number; rows: Row[] }

async function main() {
  const h = await startHarness();
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { UserModel } = await import('../src/modules/user/user.model.js');
  const { contextFor } = await import('../src/core/middleware/tenant.js');
  const { due } = await import('../src/modules/refills/refills.service.js');
  const { brief } = await import('../src/modules/brief/brief.service.js');
  const { briefEmail } = await import('../src/modules/brief/brief.mail.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@refill1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Refill Pharmacy'))).id;
  owner.shopId = shopId;
  const shop = new Types.ObjectId(shopId);
  await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 10 } });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'sunita@refill1.test', name: 'Sunita', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('sunita@refill1.test');
  await cashier.post(`/invitations/${data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Sunita' });
  cashier.shopId = shopId;
  const other = await h.signIn('mina@refill2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Other Medical'))).id;

  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (c: Client, name: string) => data<{ id: string }>(await c.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((x) => x.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  const telma = await mk(owner, 'Telma 40');
  const dolo = await mk(owner, 'Dolo 650 Tablet');
  for (const [p, b] of [[telma, 'TL1'], [dolo, 'DL1']] as const) await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId: p, batchNumber: b, expiry: '2028-12', quantity: 450, mrp: 3000, purchaseRate: 1950 });
  const person = async (name: string, phone: string) => data<{ id: string }>(await owner.post('/customers', { name, phone })).id;
  const rahim = await person('Rahim Sheikh', '98300 55511');
  const sita = await person('Sita Das', '98300 55512');
  const ajay = await person('Ajay Roy', '98300 55513');
  const meena = await person('Meena Paul', '98300 55514');
  const raju = await person('Raju Sen', '98300 55515');

  // Each bill is made now, then moved back to its day.
  const now = Date.now();
  const bill = async (customerId: string, productId: string, daysAgo: number, strips = 1) => {
    const r = await owner.post('/sales', { clientRequestId: randomUUID(), customerId, items: [{ productId, quantity: strips, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: strips * 3000 }] });
    if (r.status !== 201) throw new Error(code(r));
    await SaleModel.updateOne({ shopId: shop, _id: new Types.ObjectId(data<{ id: string }>(r).id) }, { $set: { billDate: new Date(now - daysAgo * DAY) } });
  };
  // Rahim: Telma every 30 days, last 35 days ago (two bills that day are one visit) → due 5 days ago.
  await bill(rahim, telma, 95);
  await bill(rahim, telma, 65, 2);
  await bill(rahim, telma, 35);
  await bill(rahim, telma, 35);
  // Sita: every 28 days, last 30 days ago → due 2 days ago.
  await bill(sita, telma, 58);
  await bill(sita, telma, 30);
  // Ajay: Dolo two days running (no steady gap), Telma once in 180 days → not a regular of either.
  await bill(ajay, dolo, 20);
  await bill(ajay, dolo, 19);
  await bill(ajay, telma, 10);
  // Meena: every 110 days, due in 70 days → not yet. Raju: every 30, due 70 days ago → stopped coming.
  await bill(meena, telma, 150);
  await bill(meena, telma, 40);
  await bill(raju, telma, 130);
  await bill(raju, telma, 100);
  check('setup: 13 bills across 5 customers, moved back to their days', true);

  section('1. Found by rule from the bills');
  const r = await owner.get('/refills');
  check('the owner → 200', r.status === 200, code(r));
  const d = data<Due>(r);
  check('listed: Rahim (5 days late) then Sita (2 days late) — not Ajay, Meena or Raju', d.rows.map((x) => `${x.name}:${String(x.late)}`).join() === 'Rahim Sheikh:5,Sita Das:2' && d.due === 2 && d.reminded === 0, JSON.stringify(d.rows.map((x) => [x.name, x.late, x.every])));
  const rh = d.rows[0];
  check('Rahim: Telma 40, every 30 days, 3 visits (two bills on one day are one), 2 strips that day', rh?.product === 'Telma 40' && rh.every === 30 && rh.buys === 3 && rh.lastPacks === 2 && rh.inStock, JSON.stringify(rh));
  check('Sita: every 28 days, 2 visits', d.rows[1]?.every === 28 && d.rows[1].buys === 2, JSON.stringify(d.rows[1]));
  check('a cashier sees the list too (customers:view) — they make the calls', (await cashier.get('/refills')).status === 200);
  check('another shop sees none of it', data<Due>(await other.get('/refills')).rows.length === 0);

  section('2. Reminded, quiet for a week, gone once they buy');
  const put = (c: Client, customerId: string, productId: string, body: unknown) => c.put(`/refills/${customerId}/${productId}`, body);
  const rem = await put(cashier, rahim, telma, { action: 'reminded', how: 'whatsapp' });
  check('the cashier marks Rahim reminded by WhatsApp → “Marked as reminded”', rem.status === 200 && rem.json.message === 'Marked as reminded', code(rem));
  const after = data<Due>(await owner.get('/refills'));
  check('…Sita first now; Rahim last, “messaged by Sunita”; 1 to remind, 1 reminded', after.rows.map((x) => x.name).join() === 'Sita Das,Rahim Sheikh' && after.rows[1]?.reminded?.by === 'Sunita' && after.rows[1].reminded.how === 'whatsapp' && after.due === 1 && after.reminded === 1, JSON.stringify(after.rows.map((x) => [x.name, x.reminded])));
  const ownerId = (await UserModel.findOne({ email: 'rohit@refill1.test' }).lean())?._id ?? new Types.ObjectId();
  const ctx = (await contextFor(shop, ownerId)).ctx;
  const week = await due(ctx, new Date(now + 8 * DAY));
  check('8 days on, still not back → Rahim is to remind again (13 days late)', week.rows.find((x) => x.name === 'Rahim Sheikh')?.reminded === null && week.rows.find((x) => x.name === 'Rahim Sheikh')?.late === 13, JSON.stringify(week.rows.map((x) => [x.name, x.late, x.reminded])));
  await bill(rahim, telma, 0);
  check('Rahim buys Telma today → off the list', !data<Due>(await owner.get('/refills')).rows.some((x) => x.name === 'Rahim Sheikh'));

  section('3. “Not a regular”, with undo');
  const stop = await put(owner, sita, telma, { action: 'stop' });
  check('Sita taken off → “Taken off the refill list”, gone', stop.json.message === 'Taken off the refill list' && data<Due>(await owner.get('/refills')).rows.length === 0, code(stop));
  const back = await put(owner, sita, telma, { action: 'resume' });
  check('undo → “Back on the refill list”, Sita listed again', back.json.message === 'Back on the refill list' && data<Due>(await owner.get('/refills')).rows.map((x) => x.name).join() === 'Sita Das', code(back));
  check('a bad action → 422', (await put(owner, sita, telma, { action: 'remind' })).status === 422);
  check('another shop’s customer → 404', (await put(other, sita, telma, { action: 'stop' })).status === 404);
  check('a made-up id → 422', (await put(owner, 'nope', telma, { action: 'stop' })).status === 422);

  section('4. In the morning brief');
  const b = await brief(ctx, String(ownerId), new Date());
  const rf = b.todo.find((x) => x.kind === 'refill');
  check('the brief lists 1 refill due: Sita, Telma 40', rf?.kind === 'refill' && rf.count === 1 && rf.items[0]?.name === 'Sita Das' && rf.items[0].product === 'Telma 40', JSON.stringify(rf));
  const mail = briefEmail(b, 'Refill Pharmacy', 'hi');
  check('…and the morning mail says so, in Hindi', mail.text.includes('1 नियमित customer की दवा लेने की बारी है') && mail.text.includes('Sita Das — Telma 40'), mail.text.slice(0, 300));

  finish();
}

main().catch(crash);
