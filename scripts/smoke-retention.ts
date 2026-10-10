// B8b checks: day lines that outlive bills, the retention dates and notices, a deletion preview that never deletes, legal hold, new Terms.
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
interface Year { fy: string; due: boolean; summarised: boolean; wouldDelete: { bills: number } | null; keptBecauseUnpaid: number; blocked: string | null }

async function main() {
  const h = await startHarness();
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { DaySummaryModel, summarise, summariseRecent } = await import('../src/modules/retention/retention.js');
  const { TermsAcceptanceModel } = await import('../src/modules/shops/terms-acceptance.model.js');
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@ret1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const sid = new Types.ObjectId(shopId);
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const dolo = data<{ id: string }>(await owner.post('/products', { name: 'Dolo 650 Tablet', company: 'Micro Labs', salt: 'p', strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL1', expiry: '2029-12', quantity: 150, mrp: 3000, purchaseRate: 1950 });
  const kakoli = data<{ id: string }>(await owner.post('/customers', { name: 'Kakoli Ghosh', phone: '98310 55667', creditLimit: 100_000 }));
  const sell = (body: Record<string, unknown>) => owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: 1, unit: 'STRIP' }], ...body });
  const ids = [];
  ids.push(data<{ id: string }>(await sell({ payments: [{ mode: 'CASH', amount: 3000 }] })).id);
  ids.push(data<{ id: string }>(await sell({ payments: [{ mode: 'UPI', amount: 3000 }] })).id);
  ids.push(data<{ id: string }>(await sell({ customerId: kakoli.id, payments: [{ mode: 'CREDIT', amount: 3000 }] })).id);
  // Move them back to 15 Jan 2018 (FY 2017-18), well past its legal date (31 Dec 2024).
  const old = new Date('2018-01-15T06:00:00Z');
  await SaleModel.updateMany({ shopId: sid, _id: { $in: ids.map((i) => new Types.ObjectId(i)) } }, { $set: { billDate: old } });

  section('1. Day lines');
  const row = await summarise(sid, '2018-01-15');
  check('15 Jan 2018: 3 bills, ₹90, cash 30, UPI 30, udhaar 30, GST at 12%', row.bills === 3 && row.sales === 9000 && row.cash === 3000 && row.upi === 3000 && row.udhaar === 3000 && row.byRate[0]?.rate === 12 && row.fy === '2017-18', JSON.stringify(row));
  await summarise(sid, '2018-01-15');
  check('running it again leaves one line (no double)', (await DaySummaryModel.countDocuments({ shopId: sid, day: '2018-01-15' })) === 1);
  check('the nightly pass fills the last 7 days', (await summariseRecent(sid)) === 7 && (await DaySummaryModel.countDocuments({ shopId: sid })) === 8);

  section('2. What the shop sees: tier, dates, notices');
  const d = data<{ tier: string; oldestFy: string; keepUntil: string; notices: { days: number }[]; stays: string[] }>(await owner.get('/shop/data'));
  check('legal minimum, oldest FY 2017-18, kept to 31 Dec 2024, notices at 90 / 30 / 7 days', d.tier === 'legal' && d.oldestFy === '2017-18' && d.keepUntil.startsWith('2024-12-31') && d.notices.map((n) => n.days).join() === '90,30,7' && d.stays.length === 3, JSON.stringify(d));

  section('3. The deletion preview never deletes');
  await AdminUserModel.create({ email: 'root@medshop.test', name: 'Root', role: 'super' });
  const root = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('root@medshop.test', '135790', 'admin');
  const sec = data<{ secret: string }>(await root.post('/admin/auth/verify', { email: 'root@medshop.test', otp: '135790' })).secret;
  await root.post('/admin/auth/totp', { code: totpAt(sec, Math.floor(Date.now() / 30_000)) });
  const prev = async () => data<{ preview: { years: Year[]; deletes: boolean } }>(await root.get(`/admin/shops/${shopId}/retention`)).preview;
  const p1 = await prev();
  const y18 = p1.years.find((y) => y.fy === '2017-18');
  check('FY 2017-18 is due; 2 bills would go, the unpaid udhaar bill stays', !p1.deletes && y18?.due === true && y18.summarised && y18.wouldDelete?.bills === 2 && y18.keptBecauseUnpaid === 1, JSON.stringify(y18));
  check('nothing was deleted', (await SaleModel.countDocuments({ shopId: sid })) === 3);
  await DaySummaryModel.deleteOne({ shopId: sid, day: '2018-01-15' });
  check('without the day line it won’t even plan to delete', (await prev()).years.find((y) => y.fy === '2017-18')?.blocked === 'day lines missing or do not match');
  await summarise(sid, '2018-01-15');
  check('this year is far from its date', (await prev()).years.at(-1)?.wouldDelete === null);

  section('4. Legal hold and the 10-year tier (admin, with a reason)');
  check('a hold without the case name → 422', (await root.put(`/admin/shops/${shopId}/retention`, { tier: 'legal', legalHold: true, legalHoldReason: '', reason: 'GST notice received' })).status === 422);
  const hold = await root.put(`/admin/shops/${shopId}/retention`, { tier: 'legal', legalHold: true, legalHoldReason: 'GST notice ASMT-10 of 2025', reason: 'Owner told us about a GST notice' });
  check('legal hold → nothing planned for any year', hold.status === 200 && (await prev()).years.every((y) => y.blocked === 'legal hold'), code(hold));
  await root.put(`/admin/shops/${shopId}/retention`, { tier: 'y10', legalHold: false, legalHoldReason: '', reason: 'Bought the 10-year add-on' });
  const y10 = (await prev()).years.find((y) => y.fy === '2017-18');
  check('10 years: FY 2017-18 kept to 31 Mar 2028 — not due', y10?.due === false && y10.blocked?.startsWith('kept until 2028-03-31') === true, JSON.stringify(y10));
  check('the shop’s audit shows MedBox24 changed it', Boolean(await AuditLogModel.exists({ shopId: sid, text: { $regex: 'data kept: 10 years' } })));

  section('5. New Terms: only the owner agrees, it’s on the audit log');
  check('signed up on the current Terms → accepted', data<{ accepted: boolean }>(await owner.get('/shop/terms')).accepted);
  await TermsAcceptanceModel.updateMany({ shopId: sid }, { $set: { version: '2025-01' } });
  const t2 = data<{ accepted: boolean; version: string; points: unknown[] }>(await owner.get('/shop/terms'));
  check('after a new version: not accepted, points shown', !t2.accepted && t2.points.length >= 5);
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'vikram@ret1.test', name: 'vikram', roleId: roles.find((r) => r.key === 'manager')?.id });
  const mgr = await h.signIn('vikram@ret1.test');
  await mgr.post(`/invitations/${data<{ id: string }[]>(await mgr.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'vikram' });
  mgr.shopId = shopId;
  check('a manager can’t agree → 403; an old version → 409', (await mgr.post('/shop/terms/accept', { version: t2.version })).status === 403 && (await owner.post('/shop/terms/accept', { version: '2025-01' })).status === 409);
  const ok = await owner.post('/shop/terms/accept', { version: t2.version });
  check('owner agrees → accepted, logged', ok.status === 200 && data<{ accepted: boolean }>(await owner.get('/shop/terms')).accepted && Boolean(await AuditLogModel.exists({ shopId: sid, text: { $regex: 'agreed to the Terms' } })));

  await h.close();
  finish();
}

main().catch(crash);
