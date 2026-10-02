// B5b checks: loyalty settings, signup bonus, earn, redeem within the cap, FIFO lots, manual adjust, return and cancel, tiers, expiry, tenancy.
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

const RULES = {
  enabled: true,
  earnRate: 1,
  earnPerAmount: 10_000,
  minBillForEarning: 0,
  excludedCategories: [] as string[],
  earnOnDiscountedAmount: true,
  pointValue: 100,
  minPointsToRedeem: 100,
  maxRedeemPercent: 20,
  redeemMultipleOf: 10,
  pointExpiryMonths: 12,
  expiryWarningDays: 30,
  tiers: [
    { name: 'Silver', minLifetimePoints: 0, earnMultiplier: 1 },
    { name: 'Gold', minLifetimePoints: 1000, earnMultiplier: 1.25 },
    { name: 'Platinum', minLifetimePoints: 5000, earnMultiplier: 1.5 },
  ],
  birthdayBonusPoints: 100,
  signupBonusPoints: 50,
};

interface Cust { id: string; loyaltyPoints: number; tier: string; totalSpend: number }
interface Bill { id: string; billNumber: string; pointsRedeemed: number; pointsEarned: number; pointsBalance: number | null }
interface Sale { toPay: number; paidAmount: number; paymentStatus: string; payments: { mode: string; amount: number; reference: string }[]; loyaltyPointsEarned: number; loyaltyPointsRedeemed: number; loyaltyPointsReversed: number; loyaltyPointsRestored: number; loyaltyBalanceAfter: number | null }
interface Ret { total: number; cashBack: number; pointsRestored: number; pointsRestoredValue: number; pointsReversed: number }
interface Tx { type: string; points: number; balanceAfter: number; refNumber: string; reason: string }

async function main() {
  const h = await startHarness();
  const { LoyaltyModel } = await import('../src/modules/loyalty/loyalty.model.js');
  const { CustomerModel } = await import('../src/modules/customers/customer.model.js');
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { istIsoDay } = await import('../src/utils/date.js');

  const owner = await h.signIn('rohit@loyal1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const mk = async (name: string, units: Record<string, unknown>, cat: string) =>
    data<{ id: string }>(await owner.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((c) => c.name === cat)?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  const dolo = await mk('Dolo 650 Tablet', units15, 'Tablet');
  const amox = await mk('Mox 500 Capsule', units10, 'Capsule');
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL1', expiry: '2028-12', quantity: 1500, mrp: 3000, purchaseRate: 1950 });
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: amox, batchNumber: 'MX1', expiry: '2028-12', quantity: 500, mrp: 9200, purchaseRate: 6000 });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    const inv = data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? '';
    await c.post(`/invitations/${inv}/accept`, { name: email.split('@')[0] });
    c.shopId = shop1;
    return c;
  };
  const cashier = await invite('sunita@loyal1.test', 'cashier');
  const accountant = await invite('meera@loyal1.test', 'accountant');

  // ₹1,250 = Mox 10 strips (₹920) + Dolo 11 strips (₹330), the PLAN §16 example bill.
  const big = [{ productId: amox, quantity: 10, unit: 'STRIP' }, { productId: dolo, quantity: 11, unit: 'STRIP' }];
  const bill = (items: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), items, payments: [], ...over });
  const cash = (amount: number) => [{ mode: 'CASH', amount }];
  const cust = async (id: string) => data<Cust>(await owner.get(`/customers/${id}`));
  const sale = async (id: string) => data<Sale>(await owner.get(`/sales/${id}`));
  const ledger = async (id: string) => data<Tx[]>(await owner.get(`/loyalty/transactions?customerId=${id}`));
  /** Balance = sum of the ledger = sum of what the lots still hold. */
  const books = async (id: string) => {
    const c = await CustomerModel.findOne({ shopId: shop1, _id: id }).lean();
    const all = await LoyaltyModel.find({ shopId: shop1, customerId: id }).lean();
    const tx = all.reduce((s, x) => s + x.points, 0);
    const lots = all.reduce((s, x) => s + (x.remaining ?? 0), 0);
    return { points: c?.loyaltyPoints ?? -1, tx, lots, ok: c?.loyaltyPoints === tx && tx === lots };
  };

  section('1. Settings: off until the owner sets them up');
  const s0 = data<{ enabled: boolean; configured: boolean }>(await cashier.get('/loyalty/settings'));
  check('a new shop: points off, not set up', !s0.enabled && !s0.configured);
  const kakoli = data<Cust>(await owner.post('/customers', { name: 'Kakoli Ghosh', phone: '98310 55667' }));
  check('a customer added while off gets no signup points', kakoli.loyaltyPoints === 0 && (await LoyaltyModel.countDocuments({ shopId: shop1 })) === 0);
  const off = data<Bill>(await owner.post('/sales', bill(big, { customerId: kakoli.id, payments: cash(125_000) })));
  check('a bill while off earns nothing', off.pointsEarned === 0);
  check('redeem while off → 422', (await owner.post('/sales', bill(big, { customerId: kakoli.id, redeemPoints: 100, payments: cash(115_000) }))).status === 422);
  check('cashier and accountant can’t change settings → 403', (await cashier.patch('/loyalty/settings', RULES)).status === 403 && (await accountant.patch('/loyalty/settings', RULES)).status === 403);
  const twins = await owner.patch('/loyalty/settings', { ...RULES, tiers: [{ name: 'Silver', minLifetimePoints: 0, earnMultiplier: 1 }, { name: 'Gold', minLifetimePoints: 0, earnMultiplier: 1.25 }] });
  const late = await owner.patch('/loyalty/settings', { ...RULES, tiers: [{ name: 'Silver', minLifetimePoints: 500, earnMultiplier: 1 }] });
  check('tiers must climb, the first from 0 → 422', twins.status === 422 && late.status === 422, `${code(twins)} | ${code(late)}`);
  check('point value 0 → 422', (await owner.patch('/loyalty/settings', { ...RULES, pointValue: 0 })).status === 422);
  const saved = await owner.patch('/loyalty/settings', RULES);
  check('owner sets points up → configured', saved.status === 200 && data<{ configured: boolean; enabled: boolean }>(saved).configured, code(saved));
  check('audit: loyalty settings saved', (await AuditLogModel.countDocuments({ shopId: shop1, module: 'loyalty', text: /points on · 1 point per ₹100\.00 · worth ₹1\.00/ })) === 1);
  const pos = data<{ loyalty: { enabled: boolean; canRedeem: boolean; canSetUp: boolean; pointValue: number } }>(await cashier.get('/pos/settings'));
  check('POS settings tell the counter the rules; cashier may redeem, not set up', pos.loyalty.enabled && pos.loyalty.canRedeem && !pos.loyalty.canSetUp && pos.loyalty.pointValue === 100);

  section('2. Signup bonus and earning');
  const ratna = data<Cust>(await cashier.post('/customers', { name: 'Ratna Sen', phone: '98300 12345' }));
  const lot = await LoyaltyModel.findOne({ shopId: shop1, customerId: ratna.id }).lean();
  const months = lot?.expiresAt ? Math.round((lot.expiresAt.getTime() - Date.now()) / (30.44 * 24 * 3600 * 1000)) : 0;
  check('new customer: 50 signup points, a lot that expires in 12 months, Silver', ratna.loyaltyPoints === 50 && lot?.type === 'SIGNUP' && lot.remaining === 50 && months === 12 && ratna.tier === 'Silver', `${String(ratna.loyaltyPoints)} ${String(months)} ${ratna.tier}`);
  const b1 = data<Bill>(await cashier.post('/sales', bill(big, { customerId: ratna.id, payments: cash(125_000) })));
  const s1 = await sale(b1.id);
  check('PLAN §16: ₹1,250 Silver → 12 points, balance 62', b1.pointsEarned === 12 && b1.pointsBalance === 62 && s1.loyaltyPointsEarned === 12 && s1.loyaltyBalanceAfter === 62, JSON.stringify(b1));
  const walk = data<Bill>(await cashier.post('/sales', bill([{ productId: dolo, quantity: 1, unit: 'STRIP' }], { payments: cash(3000) })));
  check('walk-in earns nothing', walk.pointsEarned === 0 && walk.pointsBalance === null);

  section('3. Manual points (loyalty:edit, D23)');
  check('cashier can’t adjust → 403', (await cashier.post('/loyalty/adjust', { clientRequestId: randomUUID(), customerId: ratna.id, points: 10, reason: 'Try' })).status === 403);
  const tooMuch = await owner.post('/loyalty/adjust', { clientRequestId: randomUUID(), customerId: ratna.id, points: -100, reason: 'Wrong entry' });
  check('take off more than she has → 422', tooMuch.status === 422, code(tooMuch));
  check('no reason → 422', (await owner.post('/loyalty/adjust', { clientRequestId: randomUUID(), customerId: ratna.id, points: 10, reason: '' })).status === 422);
  const key = randomUUID();
  const add = await owner.post('/loyalty/adjust', { clientRequestId: key, customerId: ratna.id, points: 300, reason: 'Opening balance from old software' });
  const again = await owner.post('/loyalty/adjust', { clientRequestId: key, customerId: ratna.id, points: 300, reason: 'Opening balance from old software' });
  check('owner adds 300 → 362; the same request again changes nothing', add.status === 201 && data<{ balance: number }>(add).balance === 362 && again.status === 200 && (await cust(ratna.id)).loyaltyPoints === 362, code(add));
  check('audit: added 300 points with the reason', (await AuditLogModel.countDocuments({ shopId: shop1, text: /added 300 points to Ratna Sen · Opening balance/ })) === 1);

  section('4. Redeem at the counter');
  const over = await cashier.post('/sales', bill(big, { customerId: ratna.id, redeemPoints: 260, payments: cash(99_000) }));
  check('260 points on ₹1,250 (cap 20 % = 250) → 409 with what is usable', over.status === 409 && details(over).usable === 250 && details(over).balance === 362, code(over));
  check('255 (not a multiple of 10) → 422', (await cashier.post('/sales', bill(big, { customerId: ratna.id, redeemPoints: 255, payments: cash(99_500) }))).status === 422);
  check('points without a customer → 422', (await cashier.post('/sales', bill(big, { redeemPoints: 100, payments: cash(115_000) }))).status === 422);
  const full = await cashier.post('/sales', bill(big, { customerId: ratna.id, redeemPoints: 250, payments: cash(125_000) }));
  check('paying the full ₹1,250 while using ₹250 of points → 422 (must be ₹1,000)', full.status === 422 && /₹1,000\.00/.test(full.json.error?.message ?? ''), code(full));
  const r2 = await cashier.post('/sales', bill(big, { customerId: ratna.id, redeemPoints: 250, payments: cash(100_000) }));
  const b2 = data<Bill>(r2);
  const s2 = await sale(b2.id);
  check('250 points = ₹250 off → pays ₹1,000, earns 10 on ₹1,000, balance 122', r2.status === 201 && b2.pointsRedeemed === 250 && b2.pointsEarned === 10 && b2.pointsBalance === 122, code(r2));
  check('bill: total stays ₹1,250 (GST untouched), toPay ₹1,000, a POINTS line “250 pts”, paid', s2.toPay === 100_000 && s2.payments.some((p) => p.mode === 'POINTS' && p.amount === 25_000 && p.reference === '250 pts') && s2.paidAmount === 125_000 && s2.paymentStatus === 'paid');
  const lots = await LoyaltyModel.find({ shopId: shop1, customerId: ratna.id, remaining: { $exists: true } }).sort({ createdAt: 1, _id: 1 }).lean();
  check('FIFO: signup and first earn used up, 112 of the 300 left, the new 10 untouched', lots.map((l) => l.remaining).join(',') === '0,0,112,10', lots.map((l) => `${l.type}:${String(l.remaining)}`).join(' '));
  const bk2 = await books(ratna.id);
  check('books: balance = ledger = lots (122)', bk2.ok && bk2.points === 122, JSON.stringify(bk2));

  section('5. Two counters, the same points');
  const race = await Promise.all([1, 2].map(() => cashier.post('/sales', bill([{ productId: dolo, quantity: 17, unit: 'STRIP' }], { customerId: ratna.id, redeemPoints: 100, payments: cash(41_000) }))));
  check('122 points, two ₹510 bills each using 100 → one bill, one 409', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 1, race.map(code).join(' | '));
  const bk5 = await books(ratna.id);
  check('books after the race: 122 − 100 + 4 = 26', bk5.ok && bk5.points === 26, JSON.stringify(bk5));

  section('6. Return: points follow the goods back');
  const ra = await owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: b2.id, items: [{ line: 0, quantity: 50, reason: 'Doctor changed it' }], refundMode: 'CASH' });
  const ret1 = data<Ret>(ra);
  check('Mox 5 strips (₹460): 92 redeemed points back (₹92), 3 earned taken back, ₹368 cash', ra.status === 201 && ret1.total === 46_000 && ret1.pointsRestored === 92 && ret1.pointsRestoredValue === 9200 && ret1.pointsReversed === 3 && ret1.cashBack === 36_800, JSON.stringify(ret1));
  const rb = await owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: b2.id, items: [{ line: 0, quantity: 50, reason: 'Not needed' }, { line: 1, quantity: 165, reason: 'Not needed' }], refundMode: 'CASH' });
  const ret2 = data<Ret>(rb);
  check('the rest: 158 + 92 = all 250 back, 7 + 3 = all 10 taken, ₹632 cash', rb.status === 201 && ret2.pointsRestored === 158 && ret2.pointsReversed === 7 && ret2.cashBack === 63_200, JSON.stringify(ret2));
  const s2b = await sale(b2.id);
  check('cash back ₹368 + ₹632 = the ₹1,000 cash paid · bill totals 10 / 250', ret1.cashBack + ret2.cashBack === 100_000 && s2b.loyaltyPointsReversed === 10 && s2b.loyaltyPointsRestored === 250);
  const bk6 = await books(ratna.id);
  check('books: 26 − 3 + 92 − 7 + 158 = 266', bk6.ok && bk6.points === 266, JSON.stringify(bk6));
  check('spend: ₹1,250 + ₹1,000 + ₹410 − ₹368 − ₹632 = ₹1,660', (await cust(ratna.id)).totalSpend === 166_000);
  const day = data<{ cash: { cashSales: number; points: number } }>(await owner.get(`/day-close?day=${istIsoDay(new Date())}`)).cash;
  const today = await SaleModel.find({ shopId: shop1 }).lean();
  const sumMode = (m: string) => today.reduce((s, x) => s + x.payments.filter((p) => p.mode === m).reduce((a, p) => a + p.amount, 0), 0);
  check('day close: points are not cash (cash ₹ = CASH lines only, points shown apart)', day.cashSales === sumMode('CASH') && day.points === sumMode('POINTS') && day.points === 35_000, `${String(day.cashSales)} ${String(day.points)}`);

  section('7. Cancel gives redeemed points back and takes earned ones');
  const before = await cust(ratna.id);
  const b3 = data<Bill>(await cashier.post('/sales', bill(big, { customerId: ratna.id, redeemPoints: 250, payments: cash(100_000) })));
  check('266 → use 250, earn 10 → 26', b3.pointsBalance === 26);
  const cx = await owner.post(`/sales/${b3.id}/cancel`, { reason: 'Billed twice' });
  check('cancel → 250 back, 10 taken: 266 again, spend as before', cx.status === 200 && (await cust(ratna.id)).loyaltyPoints === 266 && (await cust(ratna.id)).totalSpend === before.totalSpend, code(cx));
  const tx7 = await ledger(ratna.id);
  check('ledger: REVERSAL +250 and −10 on the bill', tx7.some((x) => x.type === 'REVERSAL' && x.points === 250 && x.refNumber === b3.billNumber) && tx7.some((x) => x.type === 'REVERSAL' && x.points === -10 && x.refNumber === b3.billNumber));
  const life = await CustomerModel.findOne({ shopId: shop1, _id: ratna.id }).lean();
  check('lifetime: earned 50+12+300+10+4 −10 (returned) +10 −10 (cancelled) = 366; redeemed 250+100 −250 (returned) +250 −250 (cancelled) = 100', life?.lifetimePointsEarned === 366 && life.lifetimePointsRedeemed === 100, `${String(life?.lifetimePointsEarned)} ${String(life?.lifetimePointsRedeemed)}`);

  section('8. Excluded categories and tiers');
  await owner.patch('/loyalty/settings', { ...RULES, excludedCategories: ['Capsule'] });
  const b4 = data<Bill>(await cashier.post('/sales', bill(big, { customerId: ratna.id, payments: cash(125_000) })));
  check('Capsules excluded: only Dolo’s ₹330 earns → 3 points', b4.pointsEarned === 3, JSON.stringify(b4));
  const r4 = data<Ret>(await owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: b4.id, items: [{ line: 0, quantity: 100, reason: 'Wrong strength' }], refundMode: 'CASH' }));
  check('returning the excluded Mox takes no points back', r4.pointsReversed === 0 && r4.pointsRestored === 0 && r4.cashBack === 92_000, JSON.stringify(r4));
  await owner.patch('/loyalty/settings', RULES);
  await owner.post('/loyalty/adjust', { clientRequestId: randomUUID(), customerId: ratna.id, points: 1000, reason: 'Festival bonus' });
  check('lifetime 1,369 → Gold', (await cust(ratna.id)).tier === 'Gold');
  const b5 = data<Bill>(await cashier.post('/sales', bill([{ productId: dolo, quantity: 34, unit: 'STRIP' }], { customerId: ratna.id, payments: cash(102_000) })));
  check('Gold 1.25×: ₹1,020 → 10 → 12 points', b5.pointsEarned === 12, JSON.stringify(b5));

  section('9. Expiry, oldest first');
  const old = await LoyaltyModel.findOne({ shopId: shop1, customerId: ratna.id, remaining: { $gt: 0 }, reason: { $ne: 'Festival bonus' } }).sort({ createdAt: 1, _id: 1 }).lean();
  const left = old?.remaining ?? 0;
  const had = (await cust(ratna.id)).loyaltyPoints;
  await LoyaltyModel.updateOne({ shopId: shop1, _id: old?._id }, { $set: { expiresAt: new Date(Date.now() - 24 * 3600 * 1000) } });
  const fest = await LoyaltyModel.findOne({ shopId: shop1, customerId: ratna.id, reason: 'Festival bonus' }).lean();
  await LoyaltyModel.updateOne({ shopId: shop1, _id: fest?._id }, { $set: { expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000) } });
  const after = await cust(ratna.id);
  check(`the oldest lot with points left (${String(left)}) passes its date → expires when the customer is opened`, left > 0 && after.loyaltyPoints === had - left, `${String(had)} → ${String(after.loyaltyPoints)}`);
  const tx9 = await ledger(ratna.id);
  check('one EXPIRE entry, and opening again doesn’t expire twice', tx9.filter((x) => x.type === 'EXPIRE').length === 1 && tx9.find((x) => x.type === 'EXPIRE')?.points === -left && (await cust(ratna.id)).loyaltyPoints === after.loyaltyPoints);
  const card = data<{ points: number; tier: string; nextTier: { name: string; need: number } | null; expiring: { points: number } | null }>(await cashier.get(`/loyalty/customers/${ratna.id}`));
  const lifetime = (await CustomerModel.findOne({ shopId: shop1, _id: ratna.id }).lean())?.lifetimePointsEarned ?? 0;
  check(`points card: Gold, ${String(5000 - lifetime)} to Platinum (lifetime ${String(lifetime)}), 1,000 expiring within 30 days`, lifetime === 1381 && card.tier === 'Gold' && card.nextTier?.name === 'Platinum' && card.nextTier.need === 5000 - lifetime && card.expiring?.points === 1000, JSON.stringify(card));
  const bk9 = await books(ratna.id);
  check('books still square after expiry', bk9.ok, JSON.stringify(bk9));

  section('10. Summary and other shops');
  const sum = data<{ issued: number; redeemed: number; expired: number; outstanding: number; liability: number; tiers: { name: string; customers: number }[]; expiring: { name: string; points: number }[] }>(await accountant.get('/loyalty/summary'));
  const all = await LoyaltyModel.find({ shopId: shop1 }).lean();
  const of = (...t: string[]) => all.filter((x) => t.includes(x.type)).reduce((s, x) => s + x.points, 0);
  const held = (await CustomerModel.find({ shopId: shop1 }).lean()).reduce((s, c) => s + c.loyaltyPoints, 0);
  check('accountant reads the summary: issued / redeemed / expired match the ledger', sum.issued === of('EARN', 'SIGNUP', 'BIRTHDAY') && sum.redeemed === -of('REDEEM') && sum.expired === left, JSON.stringify(sum));
  check('outstanding = every customer’s points; liability = × ₹1', sum.outstanding === held && sum.liability === held * 100);
  check('tier mix and who expires soon', sum.tiers.find((t) => t.name === 'Gold')?.customers === 1 && sum.expiring[0]?.name === 'Ratna Sen' && sum.expiring[0].points === 1000);

  const other = await h.signIn('owner@loyal2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Another Pharmacy'))).id;
  check('another shop: its own settings (off)', !data<{ enabled: boolean }>(await other.get('/loyalty/settings')).enabled);
  check('another shop can’t read Ratna’s card → 404, nor adjust her → 404', (await other.get(`/loyalty/customers/${ratna.id}`)).status === 404 && (await other.post('/loyalty/adjust', { clientRequestId: randomUUID(), customerId: ratna.id, points: 5, reason: 'Steal' })).status === 404);
  check('another shop’s ledger for her id is empty', data<Tx[]>(await other.get(`/loyalty/transactions?customerId=${ratna.id}`)).length === 0);

  await h.close();
  finish();
}

main().catch(crash);
