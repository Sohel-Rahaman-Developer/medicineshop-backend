// B6a checks: live alerts per role (D22), read / snooze per person, preferences, events, the mail queue, digests and nightly jobs.
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

interface Item { key: string; type: string; priority: string; unread: boolean; snoozedUntil: string | null; title: string }
interface List { items: Item[]; unread: number; urgent: number; snoozed: number }
interface Pref { type: string; locked: boolean; inapp: boolean; email: boolean }

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;
/** Today at hh:mm on the IST clock. */
const istAt = (h: number, m: number) => new Date(Math.floor((Date.now() + IST) / DAY) * DAY - IST + (h * 60 + m) * 60_000);

async function main() {
  const h = await startHarness();
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { EmailJobModel } = await import('../src/services/mail-queue.js');
  const { JobRunModel, tick } = await import('../src/modules/notifications/jobs.js');
  const { list: listFor } = await import('../src/modules/notifications/notifications.service.js');
  const { contextFor } = await import('../src/core/middleware/tenant.js');
  const { LoyaltyModel } = await import('../src/modules/loyalty/loyalty.model.js');
  const { CustomerModel } = await import('../src/modules/customers/customer.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { Types } = await import('mongoose');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');

  const owner = await h.signIn('rohit@notif1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (name: string, reorderLevel = 0) =>
    data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel, reorderQuantity: 0 })).id;
  const dolo = await mk('Dolo 650 Tablet');
  const low = await mk('Shelcal 500', 50);
  await mk('Crocin Advance');
  for (const b of ['E0', 'E10', 'E45']) await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: b, expiry: '2028-12', quantity: 150, mrp: 3000, purchaseRate: 1950 });
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: low, batchNumber: 'SH1', expiry: '2028-12', quantity: 30, mrp: 12_000, purchaseRate: 8000 });
  // One batch past its date, one inside 30 days, one in 31–60.
  await BatchModel.updateOne({ shopId: shop1, batchNumber: 'E0' }, { $set: { expiryDate: new Date(Date.now() - DAY) } });
  await BatchModel.updateOne({ shopId: shop1, batchNumber: 'E10' }, { $set: { expiryDate: new Date(Date.now() + 10 * DAY) } });
  await BatchModel.updateOne({ shopId: shop1, batchNumber: 'E45' }, { $set: { expiryDate: new Date(Date.now() + 45 * DAY) } });

  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    const inv = data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? '';
    await c.post(`/invitations/${inv}/accept`, { name: email.split('@')[0] });
    c.shopId = shop1;
    return c;
  };
  const cashier = await invite('sunita@notif1.test', 'cashier');
  const keeper = await invite('arif@notif1.test', 'stockKeeper');
  const accountant = await invite('meera@notif1.test', 'accountant');
  const manager = await invite('vikram@notif1.test', 'manager');
  const get = async (c: typeof owner, all = false) => data<List>(await c.get(`/notifications${all ? '?all=1' : ''}`));
  const types = (l: List) => l.items.map((i) => i.type);

  section('1. Who sees what (PLAN §17, D22)');
  const o1 = await get(owner);
  check('owner: expired (critical, first), 30-day, 60-day, low stock, out of stock, loyalty not set up', o1.items[0]?.type === 'EXPIRED' && o1.items[0].priority === 'critical' && ['EXPIRY_SOON', 'EXPIRY_NEXT', 'STOCK_LOW', 'STOCK_OUT', 'LOYALTY_SETUP'].every((x) => types(o1).includes(x)), types(o1).join(','));
  check('owner: 1 expired batch named, unread counts it, urgent = critical + high', /^1 batch expired/.test(o1.items[0]?.title ?? '') && o1.unread === o1.items.length && o1.urgent === o1.items.filter((i) => ['critical', 'high'].includes(i.priority)).length, `${o1.items[0]?.title ?? ''} ${String(o1.urgent)}`);
  const c1 = await get(cashier);
  check('cashier (stock: view) gets stock alerts but no expiry — D22', types(c1).includes('STOCK_LOW') && !types(c1).some((x) => x.startsWith('EXP')), types(c1).join(','));
  check('cashier: no owner-only loyalty set-up', !types(c1).includes('LOYALTY_SETUP'));
  const k1 = await get(keeper);
  check('stock keeper gets the expiry alerts', types(k1).includes('EXPIRED') && types(k1).includes('EXPIRY_SOON'));
  const a1 = await get(accountant);
  check('accountant: no expiry alerts', !types(a1).some((x) => x.startsWith('EXP')), types(a1).join(','));
  check('manager: expiry and loyalty set-up', types(await get(manager)).includes('EXPIRED') && types(await get(manager)).includes('LOYALTY_SETUP'));

  section('1b. The shop picks its own expiry alert days');
  const st0 = data<{ expiryAlertDays: number[]; windows: { type: string; what: string }[] }>(await owner.get('/notifications/settings'));
  check('default 90 / 60 / 30 → expired + 3 windows, nearest first', st0.expiryAlertDays.join(',') === '90,60,30' && st0.windows.map((w) => w.what).join(' | ') === 'expired — take them off the shelf | expire within 30 days | expire in 31–60 days | expire in 61–90 days', st0.windows.map((w) => w.what).join(' | '));
  const body = { expiryAlertDays: [7, 15, 45], alertDigestTime: '07:30', dailySummaryTime: '21:30', emailEnabled: true };
  check('cashier and accountant can’t change them → 403', (await cashier.put('/notifications/settings', body)).status === 403 && (await accountant.put('/notifications/settings', body)).status === 403);
  const bad = await Promise.all([{ ...body, expiryAlertDays: [0] }, { ...body, expiryAlertDays: [7, 7] }, { ...body, expiryAlertDays: [1, 2, 3, 4, 5, 6] }, { ...body, expiryAlertDays: [400] }, { ...body, alertDigestTime: '25:00' }].map((b) => owner.put('/notifications/settings', b)));
  check('0 days, the same day twice, 6 values, 400 days, 25:00 → 422 each', bad.every((r) => r.status === 422), bad.map((r) => r.status).join(','));
  const put = await manager.put('/notifications/settings', body);
  check('manager picks 7, 15 and 45 days → saved, furthest first', put.status === 200 && data<{ expiryAlertDays: number[] }>(put).expiryAlertDays.join(',') === '45,15,7', code(put));
  const ow = await get(owner);
  const titleOf = (type: string) => ow.items.find((i) => i.type === type)?.title ?? '';
  check('the 10-day batch is now “expire in 8–15 days”, the 45-day one “16–45 days”; nothing within 7', /^1 batch expires in 8–15 days/.test(titleOf('EXPIRY_NEXT')) && /^1 batch expires in 16–45 days/.test(titleOf('EXPIRY_AHEAD')) && !titleOf('EXPIRY_SOON'), `${titleOf('EXPIRY_NEXT')} | ${titleOf('EXPIRY_AHEAD')}`);
  check('audit: expiry alerts 90/60/30 → 45/15/7 days, digest 08:00 → 07:30', (await AuditLogModel.countDocuments({ shopId: shop1, text: /expiry alerts 90\/60\/30 → 45\/15\/7 days · digest 08:00 → 07:30/ })) === 1);
  await owner.put('/notifications/settings', { expiryAlertDays: [90, 60, 30], alertDigestTime: '08:00', dailySummaryTime: '22:00', emailEnabled: true });

  section('2. Read and “Later” are per person');
  const k30 = o1.items.find((i) => i.type === 'EXPIRY_SOON')?.key ?? '';
  await owner.post('/notifications/read', { keys: [k30] });
  const o2 = await get(owner);
  check('owner reads the 30-day alert → one less unread', o2.unread === o1.unread - 1 && o2.items.find((i) => i.key === k30)?.unread === false);
  check('the stock keeper still has it unread', (await get(keeper)).items.find((i) => i.key === k30)?.unread === true);
  const kExp = o1.items.find((i) => i.type === 'EXPIRED')?.key ?? '';
  const crit = await owner.post('/notifications/snooze', { key: kExp });
  check('“Later” on a critical alert → 422', crit.status === 422, code(crit));
  const k60 = o1.items.find((i) => i.type === 'EXPIRY_NEXT')?.key ?? '';
  const sz = await owner.post('/notifications/snooze', { key: k60 });
  const until = new Date(data<{ until: string }>(sz).until);
  check('“Later” on the 60-day alert → hidden until 9 AM IST tomorrow', sz.status === 200 && until.getTime() === istAt(9, 0).getTime() + DAY && !types(await get(owner)).includes('EXPIRY_NEXT'), code(sz));
  const allList = await get(owner, true);
  check('…but listed with all=1, marked snoozed; count of snoozed = 1', allList.items.find((i) => i.key === k60)?.snoozedUntil !== null && (await get(owner)).snoozed === 1);
  await owner.post('/notifications/unsnooze', { key: k60 });
  check('back in the list after “Show again”', types(await get(owner)).includes('EXPIRY_NEXT'));
  await owner.post('/notifications/read', { all: true });
  check('mark all read → 0 unread', (await get(owner)).unread === 0);
  check('a key from nowhere → 404 on “Later”', (await owner.post('/notifications/snooze', { key: 'NOPE:1' })).status === 404);

  section('3. Preferences (critical ones locked)');
  const p0 = data<Pref[]>(await owner.get('/notifications/preferences'));
  check('EXPIRED and SUBSCRIPTION_EXPIRED are locked on; the further window is in-app only by default', p0.find((p) => p.type === 'EXPIRED')?.locked === true && p0.find((p) => p.type === 'SUBSCRIPTION_EXPIRED')?.locked === true && p0.find((p) => p.type === 'EXPIRY_AHEAD')?.email === false);
  const saved = await owner.put('/notifications/preferences', { off: [{ kind: 'EXPIRY_NEXT', channel: 'inapp' }, { kind: 'EXPIRED', channel: 'inapp' }, { kind: 'STOCK_LOW', channel: 'email' }] });
  const p1 = data<Pref[]>(saved);
  check('turning off 60-day in-app works; turning off EXPIRED is ignored', saved.status === 200 && p1.find((p) => p.type === 'EXPIRY_NEXT')?.inapp === false && p1.find((p) => p.type === 'EXPIRED')?.inapp === true, code(saved));
  const o3 = await get(owner);
  check('the list follows: no 60-day, expired still there', !types(o3).includes('EXPIRY_NEXT') && types(o3).includes('EXPIRED'));
  check('a type that isn’t there → 422', (await owner.put('/notifications/preferences', { off: [{ kind: 'NOPE', channel: 'inapp' }] })).status === 422);

  section('4. Events: a big discount, a tier up');
  const r = await owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: 1, unit: 'STRIP' }], billDiscount: { type: 'pct', value: 25 }, payments: [{ mode: 'CASH', amount: 2300 }] });
  check('a 25 % bill (limit 20 %) is saved — no approval (D43)', r.status === 201, code(r));
  check('owner hears of it; the manager doesn’t (owner-only event)', types(await get(owner)).includes('LARGE_DISCOUNT') && !types(await get(manager)).includes('LARGE_DISCOUNT'));
  const rules = data<Record<string, unknown>>(await owner.get('/loyalty/settings'));
  delete rules.configured;
  await owner.patch('/loyalty/settings', { ...rules, enabled: true, tiers: [{ name: 'Silver', minLifetimePoints: 0, earnMultiplier: 1 }, { name: 'Gold', minLifetimePoints: 52, earnMultiplier: 1.25 }] });
  const ratna = data<{ id: string }>(await owner.post('/customers', { name: 'Ratna Sen', phone: '98300 12345' }));
  await owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: 10, unit: 'STRIP' }], customerId: ratna.id, payments: [{ mode: 'CASH', amount: 30_000 }] });
  check('50 signup + 3 earned → Gold → the cashier (customers: view) sees the tier up', types(await get(cashier)).includes('LOYALTY_TIER_UP'));
  check('loyalty set up → the set-up alert is gone', !types(await get(owner)).includes('LOYALTY_SETUP'));

  section('5. Daily summary after 10 PM');
  const ownerId = new Types.ObjectId(data<{ user: { id: string } }>(await owner.get('/auth/me')).user.id);
  const ctx = (await contextFor(new Types.ObjectId(shop1), ownerId)).ctx;
  const night = await listFor(ctx, String(ownerId), { now: istAt(22, 30) });
  const sum = night.items.find((i) => i.type === 'DAILY_SUMMARY');
  check('at 22:30 IST: “Today: 2 bills · ₹323”', sum?.title === 'Today: 2 bills · ₹323', sum?.title ?? 'none');

  section('6. Jobs: digest, summary, nightly — once a day each');
  await EmailJobModel.deleteMany({});
  await JobRunModel.deleteMany({});
  const morning = await tick(istAt(8, 5));
  check('08:05 IST: nightly and the morning digest ran', morning.ran.includes('nightly:Shri Ram Medical Store') && morning.ran.includes('digest:Shri Ram Medical Store'), morning.ran.join(','));
  const mails = await EmailJobModel.find({ kind: 'digest' }).lean();
  const to = mails.map((m) => m.to).sort();
  check('digest mails: owner, manager, stock keeper (expiry), cashier and accountant (stock) — one each', to.join(',') === ['arif@notif1.test', 'meera@notif1.test', 'rohit@notif1.test', 'sunita@notif1.test', 'vikram@notif1.test'].join(','), to.join(','));
  const own = mails.find((m) => m.to === 'rohit@notif1.test');
  check('owner’s digest leads with the expired batch and skips low stock (email off)', /expired/.test(own?.subject ?? '') && !/below reorder/.test(own?.text ?? '') && /Out of stock|out of stock/.test(own?.text ?? ''), own?.subject ?? '');
  const again = await tick(istAt(8, 6));
  check('the next minute: nothing runs twice', !again.ran.length && (await EmailJobModel.countDocuments({ kind: 'digest' })) === 5, again.ran.join(','));
  check('the queued mail went out (dev SMTP fallback) — status sent', (await EmailJobModel.countDocuments({ status: 'sent' })) === 5, String(await EmailJobModel.countDocuments({ status: 'sent' })));
  const eve = await tick(istAt(22, 5));
  const sumMails = await EmailJobModel.find({ kind: 'summary' }).lean();
  check('22:05 IST: the daily summary to owner and manager only', eve.ran.includes('summary:Shri Ram Medical Store') && sumMails.map((m) => m.to).sort().join(',') === 'rohit@notif1.test,vikram@notif1.test', sumMails.map((m) => m.to).join(','));

  section('7. Nightly points: expiry and birthdays');
  const lot = await LoyaltyModel.findOne({ shopId: shop1, customerId: ratna.id, remaining: { $gt: 0 } }).sort({ createdAt: 1 }).lean();
  await LoyaltyModel.updateOne({ shopId: shop1, _id: lot?._id }, { $set: { expiresAt: new Date(Date.now() - DAY) } });
  const istNow = new Date(Date.now() + IST);
  await CustomerModel.updateOne({ shopId: shop1, _id: ratna.id }, { $set: { dob: new Date(Date.UTC(1990, istNow.getUTCMonth(), istNow.getUTCDate()) - IST) } });
  await JobRunModel.deleteMany({ key: /^nightly/ });
  await tick(istAt(0, 30));
  const tx = await LoyaltyModel.find({ shopId: shop1, customerId: ratna.id }).lean();
  check(`the nightly run expires the old lot (${String(lot?.remaining ?? 0)}) and gives 100 birthday points`, tx.some((x) => x.type === 'EXPIRE' && x.points === -(lot?.remaining ?? 0)) && tx.some((x) => x.type === 'BIRTHDAY' && x.points === 100));
  await JobRunModel.deleteMany({ key: /^nightly/ });
  await tick(istAt(0, 45));
  check('a second run the same year gives no second birthday bonus', (await LoyaltyModel.countDocuments({ shopId: shop1, customerId: ratna.id, type: 'BIRTHDAY' })) === 1);
  const c = await CustomerModel.findOne({ shopId: shop1, _id: ratna.id }).lean();
  const sumTx = (await LoyaltyModel.find({ shopId: shop1, customerId: ratna.id }).lean()).reduce((s, x) => s + x.points, 0);
  check('books still square: balance = ledger', c?.loyaltyPoints === sumTx, `${String(c?.loyaltyPoints)} ${String(sumTx)}`);

  section('8. Other shops');
  const other = await h.signIn('owner@notif2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Another Pharmacy'))).id;
  const ol = await get(other);
  check('a new shop sees its own alerts only — no expiry, no discount event from shop 1', !types(ol).some((x) => x.startsWith('EXP') || x === 'LARGE_DISCOUNT' || x === 'LOYALTY_TIER_UP'), types(ol).join(','));
  check('reading shop 1’s key from shop 2 changes nothing in shop 1', (await other.post('/notifications/read', { keys: [kExp] })).status === 200 && (await get(keeper)).items.find((i) => i.key === kExp)?.unread === true);

  section('9. Audit log (S76: Owner and Manager only, read-only)');
  interface Entry { id: string; userName: string; action: string; module: string; text: string }
  const page1 = await owner.get('/audit?limit=2');
  const e1 = data<Entry[]>(page1);
  const next = (page1.json as { meta?: { nextCursor?: string; hasMore?: boolean } }).meta;
  check('owner reads the log, newest first, 2 a page with more after', page1.status === 200 && e1.length === 2 && next?.hasMore === true, code(page1));
  const e2 = data<Entry[]>(await owner.get(`/audit?limit=2&cursor=${encodeURIComponent(next?.nextCursor ?? '')}`));
  check('the next page has other entries', e2.length === 2 && !e2.some((x) => e1.some((y) => y.id === x.id)));
  const mgrRes = await manager.get('/audit?module=settings');
  check('manager filters by module: only the alert-settings changes', mgrRes.status === 200 && data<Entry[]>(mgrRes).length >= 1 && data<Entry[]>(mgrRes).every((x) => x.module === 'settings'), code(mgrRes));
  const filt = data<{ users: { id: string; name: string }[]; modules: string[] }>(await owner.get('/audit/filters'));
  const vikram = filt.users.find((u) => u.name.startsWith('vikram'));
  check('filters list the people and modules in the log', Boolean(vikram) && filt.modules.includes('sales') && filt.modules.includes('settings'), JSON.stringify(filt.users.map((u) => u.name)));
  const byUser = data<Entry[]>(await owner.get(`/audit?userId=${vikram?.id ?? ''}&action=update`));
  check('by person and action: only the manager’s updates', byUser.length >= 1 && byUser.every((x) => x.userName.startsWith('vikram') && x.action === 'update'));
  const future = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  check('a day with nothing → empty', data<Entry[]>(await owner.get(`/audit?from=${future}&to=${future}`)).length === 0);
  check('cashier, stock keeper and accountant → 403', (await cashier.get('/audit')).status === 403 && (await keeper.get('/audit')).status === 403 && (await accountant.get('/audit')).status === 403);
  check('no way to write or delete: POST / DELETE → 404', (await owner.post('/audit', {})).status === 404 && (await owner.del(`/audit/${e1[0]?.id ?? ''}`)).status === 404);
  check('a bad action filter → 422', (await owner.get('/audit?action=hack')).status === 422);
  const theirs = data<Entry[]>(await other.get('/audit?limit=100'));
  check('another shop’s log has none of shop 1’s entries', !theirs.some((x) => /Shri Ram|vikram|sunita/.test(x.text)), String(theirs.length));

  await h.close();
  finish();
}

main().catch(crash);
