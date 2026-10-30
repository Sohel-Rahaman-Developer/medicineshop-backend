// D103 checks: the morning brief — yesterday against a usual day like it, today's jobs most urgent first, only for those
// who see the shop's money, the morning mail in each person's language, and the AI reading the same figures.
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
const IST = 5.5 * 3_600_000;
const isoDay = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const todayStart = () => new Date(Math.floor((Date.now() + IST) / DAY) * DAY - IST);
const istAt = (h: number, m: number) => new Date(todayStart().getTime() + (h * 60 + m) * 60_000);

interface Todo { kind: string; count?: number; out?: number; expired?: number; mrpValue?: number; overdue?: number; dueWeek?: number; total?: number; customers?: number; items?: { name: string; out?: boolean; left?: number; sold?: number; lastsDays?: number | null }[] }
interface Brief { day: string; yesterday: { netSales: number; bills: number; grossProfit: number | null }; usual: { average: number; days: { day: string; netSales: number }[] } | null; changePercent: number | null; todo: Todo[] }

async function main() {
  const h = await startHarness();
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { ShopModel } = await import('../src/modules/shops/shop.model.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { PurchaseModel } = await import('../src/modules/purchases/purchase.model.js');
  const { CustomerModel } = await import('../src/modules/customers/customer.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { UserModel } = await import('../src/modules/user/user.model.js');
  const { EmailJobModel } = await import('../src/services/mail-queue.js');
  const { tick } = await import('../src/modules/notifications/jobs.js');
  const { contextFor } = await import('../src/core/middleware/tenant.js');
  const { runTool } = await import('../src/modules/ask/tools.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@brief1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Brief Pharmacy'))).id;
  owner.shopId = shopId;
  const shop = new Types.ObjectId(shopId);
  await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 10 } });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    await c.post(`/invitations/${data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? ''}/accept`, { name: email.split('@')[0] });
    c.shopId = shopId;
    return c;
  };
  const cashier = await invite('sunita@brief1.test', 'cashier');
  const manager = await invite('vikram@brief1.test', 'manager');
  await UserModel.updateOne({ email: 'vikram@brief1.test' }, { $set: { lang: 'hi' } });
  const quiet = await h.signIn('mina@brief2.test');
  quiet.shopId = data<{ id: string }>(await quiet.post('/shops', shopBody('Quiet Medical'))).id;

  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (c: Client, name: string, reorderLevel = 0) => data<{ id: string }>(await c.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((x) => x.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel, reorderQuantity: 0 })).id;
  const opening = (productId: string, batchNumber: string, quantity: number, mrp: number) => owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId, batchNumber, expiry: '2028-12', quantity, mrp, purchaseRate: Math.round(mrp * 0.65) });
  const dolo = await mk(owner, 'Dolo 650 Tablet', 200);
  const shelcal = await mk(owner, 'Shelcal 500');
  await mk(owner, 'Zifi 200');
  await opening(dolo, 'DL1', 150, 3000);
  await opening(shelcal, 'SH1', 30, 12_000);
  await opening(shelcal, 'SH0', 15, 12_000);
  await BatchModel.updateOne({ shopId: shop, batchNumber: 'SH1' }, { $set: { expiryDate: new Date(Date.now() + 10 * DAY) } });
  await BatchModel.updateOne({ shopId: shop, batchNumber: 'SH0' }, { $set: { expiryDate: new Date(Date.now() - 5 * DAY) } });

  // Four one-strip bills: two yesterday, one a week before, one two weeks before; the shop is 20 days old.
  const bills = [];
  for (let i = 0; i < 4; i++) bills.push(await owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: 1, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: 3000 }] }));
  check('setup: 4 bills of ₹30 (one Dolo strip each)', bills.every((r) => r.status === 201), bills.map(code).join(' | '));
  const y0 = todayStart().getTime() - DAY;
  const when = [y0 + 11 * 3_600_000, y0 + 12 * 3_600_000, y0 - 7 * DAY + 11 * 3_600_000, y0 - 14 * DAY + 11 * 3_600_000];
  const ids = bills.map((b) => data<{ id: string }>(b).id);
  for (const [i, id] of ids.entries()) await SaleModel.updateOne({ shopId: shop, _id: new Types.ObjectId(id) }, { $set: { billDate: new Date(when[i] ?? 0) } });
  await ShopModel.collection.updateOne({ _id: shop }, { $set: { createdAt: new Date(Date.now() - 20 * DAY) } });

  const sup = data<{ id: string }>(await owner.post('/suppliers', { name: 'Sharma Distributors', contactPerson: 'Anil', phone: '98311 22334', email: '', gstin: '', drugLicense: '', creditDays: 30, address: 'Kolkata' })).id;
  const pur = await owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: sup, invoiceNumber: 'SD/1', invoiceDate: isoDay(), lines: [{ productId: shelcal, batchNumber: 'SH2', expiry: '2029-01', quantity: 1, freeQuantity: 0, unit: 'STRIP', rate: 8000, discountPercent: 0, mrp: 12_000, gstRate: 12, rack: '' }] });
  check('setup: a ₹89.60 purchase on credit, now 3 days overdue', pur.status === 201, code(pur));
  await PurchaseModel.updateOne({ shopId: shop }, { $set: { dueDate: new Date(Date.now() - 3 * DAY) } });
  const rahim = data<{ id: string }>(await owner.post('/customers', { name: 'Rahim Sheikh', phone: '98300 55511' })).id;
  await CustomerModel.updateOne({ shopId: shop, _id: new Types.ObjectId(rahim) }, { $set: { creditBalance: 45_000 } });

  section('1. Who sees it');
  check('a cashier → 403 (the brief is the shop’s money)', (await cashier.get('/brief')).status === 403);
  const r = await owner.get('/brief');
  check('the owner → 200', r.status === 200, code(r));
  check('the manager → 200', (await manager.get('/brief')).status === 200);
  const b = data<Brief>(r);

  section('2. Yesterday against a usual day like it');
  check('yesterday: ₹60 in 2 bills', b.yesterday.netSales === 6000 && b.yesterday.bills === 2, JSON.stringify(b.yesterday));
  check('usual: the same weekday 1 and 2 weeks back (the shop is 20 days old, so not 3 or 4) — ₹30 + ₹30 ÷ 2 = ₹30', b.usual?.days.length === 2 && b.usual.days.every((d) => d.netSales === 3000) && b.usual.average === 3000, JSON.stringify(b.usual));
  check('(₹60 − ₹30) ÷ ₹30 = +100%', b.changePercent === 100, String(b.changePercent));
  check('gross profit shown to the owner', b.yesterday.grossProfit !== null && b.yesterday.grossProfit > 0);

  section('3. Today’s jobs, most urgent first');
  check('order: reorder (one out of stock), expiry (one expired), suppliers (overdue), udhaar, money stuck', b.todo.map((x) => x.kind).join() === 'reorder,expiry,suppliers,udhaar,dead', b.todo.map((x) => x.kind).join());
  const re = b.todo[0];
  const doloRow = re?.items?.[0];
  check('reorder: 2 (Dolo low, Zifi out); fastest-selling first', re?.count === 2 && re.out === 1 && doloRow?.name === 'Dolo 650 Tablet' && re.items?.[1]?.name === 'Zifi 200' && re.items[1].out === true, JSON.stringify(re));
  check('Dolo: 6 strips left, 4 sold in 30 days → 90 tablets ÷ 2 a day = lasts 45 days', doloRow?.left === 6 && doloRow.sold === 4 && doloRow.lastsDays === 45, JSON.stringify(doloRow));
  const ex = b.todo[1];
  check('expiry: 1 batch within 30 days, ₹240 at MRP (30 tablets × ₹120 ÷ 15), 1 already expired', ex?.count === 1 && ex.mrpValue === 24_000 && ex.expired === 1, JSON.stringify(ex));
  const pay = await PurchaseModel.findOne({ shopId: shop }).lean();
  const su = b.todo[2];
  check(`suppliers: ₹${String((pay?.dueAmount ?? 0) / 100)} overdue`, su?.overdue === pay?.dueAmount && (su?.overdue ?? 0) > 0, JSON.stringify(su));
  check('udhaar: ₹450 from Rahim', b.todo[3]?.total === 45_000 && b.todo[3].customers === 1 && b.todo[3].items?.[0]?.name === 'Rahim Sheikh', JSON.stringify(b.todo[3]));
  check('money stuck: Shelcal, never sold', b.todo[4]?.items?.some((i) => i.name === 'Shelcal 500') === true, JSON.stringify(b.todo[4]));
  const q = data<Brief>(await quiet.get('/brief'));
  check('a new, quiet shop: nothing yesterday, no usual day yet, nothing to do', q.yesterday.bills === 0 && q.usual === null && q.changePercent === null && q.todo.length === 0, JSON.stringify(q));

  section('4. The AI reads the same brief');
  const idOf = async (email: string) => (await UserModel.findOne({ email }).select('_id').lean())?._id ?? new Types.ObjectId();
  const ownerId = await idOf('rohit@brief1.test');
  const ownCtx = (await contextFor(shop, ownerId)).ctx;
  const tool = await runTool({ t: ownCtx, userId: String(ownerId), now: new Date() }, 'morning_brief', {});
  check('morning_brief tool: ₹60 yesterday, ₹30 usual, in rupees, the jobs in order', tool.ok && tool.text.includes('"netSales":"₹60"') && tool.text.includes('"average":"₹30"') && tool.text.indexOf('reorder') < tool.text.indexOf('udhaar') && tool.href === '/brief', tool.text.slice(0, 300));
  const cashierId = await idOf('sunita@brief1.test');
  const denied = await runTool({ t: (await contextFor(shop, cashierId)).ctx, userId: String(cashierId), now: new Date() }, 'morning_brief', {});
  check('…a cashier’s question gets “cannot see”', !denied.ok && denied.text.includes('cannot see'), denied.text);

  section('5. The morning mail');
  const prefs = data<{ type: string; channels: string[]; email: boolean }[]>(await owner.get('/notifications/preferences'));
  const mb = prefs.find((p) => p.type === 'MORNING_BRIEF');
  check('preferences list “Morning brief” — email only, on by default', mb?.channels.join() === 'email' && mb.email, JSON.stringify(mb));
  await EmailJobModel.deleteMany({});
  const ran = await tick(istAt(8, 5));
  check('08:05: the brief ran for the shop that has something to say', ran.ran.includes('brief:Brief Pharmacy'), ran.ran.join(','));
  const mails = await EmailJobModel.find({ kind: 'brief' }).lean();
  check('mailed to the owner and the manager — not the cashier, not the quiet shop', mails.map((m) => m.to).sort().join() === 'rohit@brief1.test,vikram@brief1.test', mails.map((m) => m.to).join());
  const own = mails.find((m) => m.to === 'rohit@brief1.test');
  check('owner: subject “Brief Pharmacy · Yesterday: ₹60 · 2 bills”, the usual-day working, the jobs, the AI', own?.subject === 'Brief Pharmacy · Yesterday: ₹60 · 2 bills' && own.text.includes('100% more than a usual day like it (₹30, same weekday, last 2 weeks)') && own.text.includes('2 medicines to reorder') && own.text.includes('Dolo 650 Tablet: only 6 left, lasts about 45 days') && own.text.includes('Ask the AI what to do first'), own?.text.slice(0, 400));
  const hi = mails.find((m) => m.to === 'vikram@brief1.test');
  check('manager (Hindi): “कल: ₹60 · 2 bill”, Hindi jobs, lang="hi"', hi?.subject === 'Brief Pharmacy · कल: ₹60 · 2 bill' && hi.text.includes('2 दवाएँ फिर से मँगानी हैं') && hi.text.includes('Dolo 650 Tablet: सिर्फ़ 6 बचे, लगभग 45 दिन चलेंगे') && /lang="hi"/.test(hi.html), hi?.subject);
  const again = await tick(istAt(8, 6));
  check('the next minute: no second brief', !again.ran.some((x) => x.startsWith('brief:')) && (await EmailJobModel.countDocuments({ kind: 'brief' })) === 2, again.ran.join(','));
  const off = await manager.put('/notifications/preferences', { off: [{ kind: 'MORNING_BRIEF', channel: 'email' }] });
  check('the manager switches the brief mail off', off.status === 200, code(off));
  const { JobRunModel, morningBrief } = await import('../src/modules/notifications/jobs.js');
  await JobRunModel.deleteMany({ key: /^brief:/ });
  await EmailJobModel.deleteMany({ kind: 'brief' });
  const sent = await morningBrief(shop, 'Brief Pharmacy', istAt(8, 5));
  check('…next morning only the owner gets it', sent === 1 && (await EmailJobModel.find({ kind: 'brief' }).lean()).map((m) => m.to).join() === 'rohit@brief1.test');

  section('6. Pro only: the trial has it, Basic does not');
  await SubscriptionModel.updateOne({ shopId: shop }, { $set: { planCode: 'basic-monthly', status: 'active', endDate: new Date(Date.now() + 30 * DAY) } });
  await JobRunModel.deleteMany({ key: /^brief:/ });
  await EmailJobModel.deleteMany({ kind: 'brief' });
  const basic = await owner.get('/brief');
  check('Basic: GET /brief → 403 PLAN_UPGRADE', basic.status === 403 && basic.json.error?.code === 'PLAN_UPGRADE', code(basic));
  check('…and no morning mail', (await morningBrief(shop, 'Brief Pharmacy', istAt(8, 5))) === 0 && (await EmailJobModel.countDocuments({ kind: 'brief' })) === 0);

  finish();
}

main().catch(crash);
