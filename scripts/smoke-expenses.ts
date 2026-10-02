// B7a checks: expenses (who, drawer cash, closed days, edit / remove audited), P&L by hand, months and the day book.
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
const RULES = {
  enabled: true, earnRate: 1, earnPerAmount: 10_000, minBillForEarning: 0, excludedCategories: [] as string[], earnOnDiscountedAmount: true, pointValue: 100, minPointsToRedeem: 100, maxRedeemPercent: 20, redeemMultipleOf: 10, pointExpiryMonths: 12, expiryWarningDays: 30,
  tiers: [{ name: 'Silver', minLifetimePoints: 0, earnMultiplier: 1 }, { name: 'Gold', minLifetimePoints: 1000, earnMultiplier: 1.25 }],
  birthdayBonusPoints: 0, signupBonusPoints: 50,
};

interface Exp { id: string; expenseNumber: string; amount: number; paymentMode: string; fromDrawer: boolean; status: string; category: string }
interface Pnl { revenue: number; cogs: number; gross: number; expenses: number; writeOff: number; points: number; net: number; bills: number; returns: number; byCategory: { category: string; total: number }[] }
interface Status { cash: { expected: number; expenses: number } | null }

const IST = 5.5 * 60 * 60 * 1000;
const DAY = 86_400_000;
const isoDay = (offset = 0) => new Date(Date.now() + IST + offset * DAY).toISOString().slice(0, 10);

async function main() {
  const h = await startHarness();
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');

  const owner = await h.signIn('rohit@exp1.test');
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
  const cashier = await invite('sunita@exp1.test', 'cashier');
  const keeper = await invite('arif@exp1.test', 'stockKeeper');
  const accountant = await invite('meera@exp1.test', 'accountant');
  const today = isoDay();
  const exp = (over: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), date: today, category: 'Staff tea', description: 'Tea for the counter', amount: 12_000, paymentMode: 'CASH', fromDrawer: true, vendor: '', referenceNumber: '', ...over });
  const status = async () => data<Status>(await owner.get('/day-close')).cash;

  section('1. Who can (PLAN §7: Owner VCEDX, Accountant VCEX, cashier and stock keeper none)');
  check('cashier and stock keeper → 403', (await cashier.get('/expenses')).status === 403 && (await keeper.post('/expenses', exp())).status === 403);
  check('accountant reads', (await accountant.get('/expenses')).status === 200);

  section('2. Adding');
  const cash0 = (await status())?.expected ?? -1;
  const teaBody = exp();
  const tea = await accountant.post('/expenses', teaBody);
  const teaE = data<Exp>(tea);
  const fy = teaE.expenseNumber.split('-').slice(1, 3).join('-');
  check('accountant adds tea ₹120 cash from the drawer → 201, EXP-…-0001', tea.status === 201 && /^EXP-\d{4}-\d{2}-0001$/.test(teaE.expenseNumber) && teaE.fromDrawer, code(tea));
  const again = await accountant.post('/expenses', teaBody);
  check('the same request again → 200, same expense, nothing doubled', again.status === 200 && data<Exp>(again).id === teaE.id);
  const rent = data<Exp>(await owner.post('/expenses', exp({ category: 'Rent', amount: 150_000, paymentMode: 'UPI', fromDrawer: true, description: 'October rent' })));
  check('rent by UPI is never drawer cash, even if asked', rent.paymentMode === 'UPI' && !rent.fromDrawer && rent.expenseNumber === `EXP-${fy}-0002`);
  const pest = data<Exp>(await owner.post('/expenses', exp({ category: 'Pest control', amount: 50_000, fromDrawer: false, vendor: 'Kill-It Services' })));
  check('own category “Pest control”, cash from the owner’s pocket', pest.category === 'Pest control' && !pest.fromDrawer);
  const bad = await Promise.all([exp({ amount: 0 }), exp({ category: '' }), exp({ date: isoDay(2) }), exp({ paymentMode: 'CHEQUE' }), exp({ date: '2026-02-30' })].map((b) => owner.post('/expenses', b)));
  check('₹0 / no category / a future day / unknown mode / 30 Feb → 422', bad.every((r) => r.status === 422), bad.map((r) => r.status).join(','));

  section('3. Drawer cash and the day close');
  const cash1 = await status();
  check('day close expects ₹120 less: only the drawer tea counts', cash1?.expenses === 12_000 && cash1.expected === cash0 - 12_000, `${String(cash0)} → ${JSON.stringify(cash1)}`);

  section('4. Change and remove, both audited');
  const ed = await accountant.patch(`/expenses/${teaE.id}`, { ...exp({ amount: 15_000 }), clientRequestId: undefined });
  check('accountant changes tea ₹120 → ₹150', ed.status === 200 && data<Exp>(ed).amount === 15_000, code(ed));
  const a1 = await AuditLogModel.findOne({ shopId: shop1, module: 'expenses', action: 'update' }).sort({ _id: -1 }).lean();
  check('audit: who and old → new', a1?.userName === 'meera' && a1.text.includes('₹120.00 → ₹150.00') && JSON.stringify(a1.changes).includes('"amount":12000'), a1?.text);
  check('day close follows the change', (await status())?.expenses === 15_000);
  const del = data<Exp>(await owner.post('/expenses', exp({ category: 'Delivery', amount: 9900 })));
  check('accountant can’t remove (no delete) → 403', (await accountant.del(`/expenses/${del.id}`, { reason: 'typo' })).status === 403);
  check('remove without a reason → 422', (await owner.del(`/expenses/${del.id}`, {})).status === 422);
  const rm = await owner.del(`/expenses/${del.id}`, { reason: 'Entered twice' });
  check('owner removes it with a reason → kept as deleted', rm.status === 200 && data<Exp>(rm).status === 'deleted', code(rm));
  const a2 = await AuditLogModel.findOne({ shopId: shop1, module: 'expenses', action: 'delete' }).lean();
  check('audit names it and why', /removed EXP-.*Delivery.*₹99\.00 — Entered twice/.test(a2?.text ?? ''), a2?.text);
  check('removing again → 404', (await owner.del(`/expenses/${del.id}`, { reason: 'again' })).status === 404);

  section('5. List and summary');
  const list = data<Exp[]>(await owner.get('/expenses?limit=2'));
  check('removed ones are gone from the list; 2 a page', list.length === 2 && !list.some((e) => e.id === del.id));
  check('filter by category', data<Exp[]>(await owner.get('/expenses?category=Rent')).every((e) => e.category === 'Rent'));
  const sum = data<{ month: number; entries: number; byCategory: { category: string; total: number }[]; categories: string[] }>(await owner.get('/expenses/summary'));
  check('this month ₹2,150 in 3 entries, rent on top; Pest control offered next time', sum.month === 215_000 && sum.entries === 3 && sum.byCategory[0]?.category === 'Rent' && sum.categories.includes('Pest control') && sum.categories.includes('Salary'), JSON.stringify(sum));

  section('6. A day of trade');
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (name: string) => data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  const dolo = await mk('Dolo 650 Tablet');
  const omron = await mk('Omron Strips');
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL1', expiry: '2028-12', quantity: 150, mrp: 3000, purchaseRate: 1950 });
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: omron, batchNumber: 'OM1', expiry: '2028-12', quantity: 30, mrp: 60_000, purchaseRate: 45_000 });
  await owner.patch('/loyalty/settings', RULES);
  const ratna = data<{ id: string }>(await owner.post('/customers', { name: 'Ratna Sen', phone: '98300 12345' }));
  await owner.post('/loyalty/adjust', { clientRequestId: randomUUID(), customerId: ratna.id, points: 150, reason: 'Opening balance' });
  const sell = (items: Record<string, unknown>[], over: Record<string, unknown>) => owner.post('/sales', { clientRequestId: randomUUID(), items, payments: [], ...over });
  const strip = (id: string) => [{ productId: id, quantity: 1, unit: 'STRIP' }];
  const bA = await sell(strip(dolo), { payments: [{ mode: 'CASH', amount: 3000 }] });
  const bB = data<{ id: string }>(await sell(strip(dolo), { payments: [{ mode: 'CASH', amount: 3000 }] }));
  const bC = await sell(strip(omron), { customerId: ratna.id, redeemPoints: 100, payments: [{ mode: 'CASH', amount: 50_000 }] });
  check('3 bills: Dolo ₹30 × 2, Omron ₹600 with 100 points (₹100)', bA.status === 201 && Boolean(bB.id) && bC.status === 201, code(bC));
  const ret = await owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: bB.id, items: [{ line: 0, quantity: 15, reason: 'Not needed' }], refundMode: 'CASH' });
  check('one Dolo strip comes back', ret.status === 201, code(ret));
  const dl1 = await BatchModel.findOne({ shopId: shop1, batchNumber: 'DL1' }).lean();
  const dmg = await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'DAMAGE', reason: 'Strip torn', lines: [{ batchId: String(dl1?._id), quantity: 15 }] });
  check('one Dolo strip written off as damaged', dmg.status === 201, code(dmg));

  section('7. P&L, worked by hand');
  const P = data<Pnl>(await owner.get(`/reports/pnl?from=${today}&to=${today}`));
  // Taxable: ₹30 → 26.79, ₹600 → 535.71. Cost: Dolo ₹19.50 a strip, Omron ₹450.
  check('revenue = 26.79 + 26.79 + 535.71 − 26.79 (return) = ₹562.50', P.revenue === 56_250, String(P.revenue));
  check('cost of goods = 19.50 × 2 + 450 − 19.50 = ₹469.50', P.cogs === 46_950, String(P.cogs));
  check('gross = ₹93.00', P.gross === 9300, String(P.gross));
  check('expenses = rent 1,500 + tea 150 + pest 500 = ₹2,150 (removed one left out)', P.expenses === 215_000 && P.byCategory.length === 3, JSON.stringify(P.byCategory));
  check('write-off = 15 tablets × ₹1.30 = ₹19.50', P.writeOff === 1950, String(P.writeOff));
  check('points used = ₹100', P.points === 10_000, String(P.points));
  check('net = 93 − 2,150 − 19.50 − 100 = −₹2,176.50', P.net === -217_650, String(P.net));
  check('3 bills, ₹30 returned', P.bills === 3 && P.returns === 3000);

  section('8. Months and the day book agree with the P&L');
  const month = today.slice(0, 7);
  const mo = data<{ month: string; current: boolean; partial: boolean; net: number }[]>(await owner.get('/reports/pnl/months'));
  check('4 months, this one last and “so far”, earlier ones before the shop = partial', mo.length === 4 && mo[3]?.month === month && mo[3].current && mo[0]?.partial === true, JSON.stringify(mo.map((m) => [m.month, m.partial])));
  const first = `${month}-01`;
  const Pm = data<Pnl>(await owner.get(`/reports/pnl?from=${first}&to=${today}`));
  check('this month’s row = the P&L for the month', mo[3]?.net === Pm.net);
  const db = data<{ days: { day: string; net: number; expenses: number }[]; total: { net: number } }>(await owner.get(`/reports/daybook?month=${month}`));
  check('day book: a row per day to today', db.days.length === Number(today.slice(8)) && db.days.at(-1)?.day === today);
  check('Σ days = total = the P&L, to the paisa', db.days.reduce((s, d) => s + d.net, 0) === db.total.net && db.total.net === Pm.net, `${String(db.total.net)} vs ${String(Pm.net)}`);
  check('today carries the expenses', db.days.at(-1)?.expenses === 215_000);

  section('9. Who sees profit');
  check('cashier → 403', (await cashier.get(`/reports/pnl?from=${today}&to=${today}`)).status === 403);
  check('accountant and stock keeper (reports: view) → 200', (await accountant.get('/reports/pnl/months')).status === 200 && (await keeper.get(`/reports/daybook?month=${month}`)).status === 200);
  check('to before from / a 2-year range / bad month → 422', (await owner.get(`/reports/pnl?from=${today}&to=${isoDay(-1)}`)).status === 422 && (await owner.get(`/reports/pnl?from=${isoDay(-800)}&to=${today}`)).status === 422 && (await owner.get('/reports/daybook?month=2026-13')).status === 422);
  const other = await h.signIn('kakoli@exp2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Kakoli Pharmacy'))).id;
  const oP = data<Pnl>(await other.get(`/reports/pnl?from=${today}&to=${today}`));
  check('another shop: nothing of shop 1', oP.revenue === 0 && oP.expenses === 0 && data<Exp[]>(await other.get('/expenses')).length === 0);
  check('another shop can’t open or remove shop 1’s expense → 404', (await other.get(`/expenses/${rent.id}`)).status === 404 && (await other.del(`/expenses/${rent.id}`, { reason: 'mine' })).status === 404);

  section('10. A closed day is final for drawer cash');
  const st = await status();
  const closed = await owner.post('/day-close', { day: today, counted: st?.expected ?? 0, takenOut: 0 });
  check('close today', closed.status === 201, code(closed));
  const hist = data<{ day: string; expenses: number }[]>(await owner.get('/day-close/history'));
  check('the close keeps the drawer expenses (₹150)', hist[0]?.expenses === 15_000, JSON.stringify(hist[0]));
  const late = await owner.post('/expenses', exp());
  check('more drawer cash on the closed day → 409 DAY_CLOSED', late.status === 409 && (late.json.error?.details as { reason?: string } | undefined)?.reason === 'DAY_CLOSED', code(late));
  check('changing or removing the drawer tea → 409', (await owner.patch(`/expenses/${teaE.id}`, { ...exp({ amount: 1 }), clientRequestId: undefined })).status === 409 && (await owner.del(`/expenses/${teaE.id}`, { reason: 'oops' })).status === 409);
  check('from outside the drawer is still fine → 201', (await owner.post('/expenses', exp({ fromDrawer: false }))).status === 201);
  check('moving rent (UPI) onto the drawer of the closed day → 409', (await owner.patch(`/expenses/${rent.id}`, { ...exp({ category: 'Rent', amount: 150_000 }), clientRequestId: undefined })).status === 409);

  await h.close();
  finish();
}

main().catch(crash);
