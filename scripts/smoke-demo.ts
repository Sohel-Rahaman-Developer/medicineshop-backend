// The marketing demo shop: made by a super admin, 60 days of trading, a sign-in code no email carries, nothing to pay.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;

interface Info {
  shop: { id: string; name: string } | null;
  code: { set: boolean };
  lockedUntil: string | null;
  filledTo: string | null;
  job: { kind: string; state: string; done: number; total: number; skipped: number; error: string | null } | null;
  counts: Record<'today' | 'week' | 'month' | 'all', { bills: number; total: number }> | null;
}

async function main() {
  // Real limits would stop the test's own sign-ins; the lock under test is the demo's own.
  Object.assign(process.env, { RATE_OTP_REQUEST_PER_EMAIL: '100', RATE_OTP_VERIFY_PER_EMAIL: '100' });
  const h = await startHarness();
  const { Types } = await import('mongoose');
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { SaleModel } = await import('../src/modules/sales/sale.model.js');
  const { PurchaseModel } = await import('../src/modules/purchases/purchase.model.js');
  const { ExpenseModel } = await import('../src/modules/expenses/expense.model.js');
  const { DayCloseModel } = await import('../src/modules/dayclose/dayclose.model.js');
  const { SaleReturnModel } = await import('../src/modules/sales/sale-return.model.js');
  const { CustomerModel } = await import('../src/modules/customers/customer.model.js');
  const { MovementModel } = await import('../src/modules/stock/movement.model.js');
  const { MembershipModel } = await import('../src/modules/memberships/membership.model.js');
  const { DemoModel } = await import('../src/modules/demo/demo.model.js');
  const { demoTick } = await import('../src/modules/demo/demo.service.js');
  const { istDayStart } = await import('../src/utils/date.js');
  const step = () => Math.floor(Date.now() / 30_000);

  await AdminUserModel.create({ email: 'root@demo.test', name: 'Root', role: 'super' });
  await AdminUserModel.create({ email: 'help@demo.test', name: 'Sara', role: 'support' });
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const s = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' })).secret ?? '';
    await c.post('/admin/auth/totp', { code: totpAt(s, step()) });
    return c;
  };
  const root = await login('root@demo.test');
  const helper = await login('help@demo.test');
  const info = async () => data<Info>(await root.get('/admin/demo'));
  const settled = async (label: string) => {
    const t0 = Date.now();
    let i = await info();
    while (i.job?.state === 'running' && Date.now() - t0 < 600_000) {
      await new Promise((r) => setTimeout(r, 1000));
      i = await info();
    }
    check(`${label}: the job finished (${String(i.job?.done)} steps, ${String(Math.round((Date.now() - t0) / 1000))} s)`, i.job?.state === 'done', JSON.stringify(i.job));
    check(`${label}: under 5 % of steps skipped (${String(i.job?.skipped)})`, (i.job?.skipped ?? 99) < (i.job?.total ?? 0) * 0.05, i.job?.error ?? '');
    return i;
  };

  section('1. Only a super admin makes it, with a reason');
  const none = await info();
  check('no demo shop yet', none.shop === null && !none.code.set);
  check('support role → 403', (await helper.post('/admin/demo', { reason: 'For the sales team' })).status === 403);
  check('no reason → 422', (await root.post('/admin/demo', {})).status === 422);
  const made = await root.post('/admin/demo', { reason: 'For the sales team' });
  check('super admin → made', made.status === 200 && data<Info>(made).shop?.name === 'MedBox24 Demo Pharmacy', code(made));
  check('making it twice → 409', (await root.post('/admin/demo', { reason: 'For the sales team' })).status === 409);
  const first = await settled('first fill');
  const shopId = new Types.ObjectId(first.shop?.id ?? '');

  section('2. 60 days of a busy shop that grows, up to now');
  const now = new Date();
  const bills = await SaleModel.find({ shopId }).select('billDate status customerId payments grandTotal').lean();
  const days = new Set(bills.map((b) => istDayStart(b.billDate).getTime()));
  check('hundreds of bills', bills.length > 300, String(bills.length));
  check('bills on 55+ different days', days.size >= 55, String(days.size));
  check('no bill in the future', bills.every((b) => b.billDate <= now));
  check('the oldest bill is about 60 days back', Math.round((now.getTime() - Math.min(...bills.map((b) => b.billDate.getTime()))) / 86_400_000) >= 59);
  const DAYMS = 86_400_000;
  const inWindow = (fromAgo: number, toAgo: number) => bills.filter((b) => b.status !== 'cancelled' && b.billDate.getTime() >= istDayStart(now).getTime() - fromAgo * DAYMS && b.billDate.getTime() < istDayStart(now).getTime() - toAgo * DAYMS);
  const early = inWindow(59, 45);
  const late = inWindow(15, 1);
  check('the shop grows: the last two weeks have 40 % more bills than the first two', late.length >= early.length * 1.4, `${String(early.length)} → ${String(late.length)}`);
  const avg = Math.round(bills.reduce((s, b) => s + b.grandTotal, 0) / bills.length / 100);
  check('an average bill of ₹400 or more', avg >= 400, `₹${String(avg)}`);
  check('udhaar, UPI, card and cash bills', ['CREDIT', 'UPI', 'CARD', 'CASH'].every((m) => bills.some((b) => b.payments.some((p) => p.mode === m))));
  check('a cancelled bill', bills.some((b) => b.status === 'cancelled'));
  check('stock movements sit on the bill times', (await MovementModel.countDocuments({ shopId, at: { $gt: now } })) === 0);
  check('purchases, some unpaid', (await PurchaseModel.countDocuments({ shopId })) >= 5 && (await PurchaseModel.countDocuments({ shopId, dueAmount: { $gt: 0 } })) > 0);
  check('rent, salary and tea in expenses', (await ExpenseModel.distinct('category', { shopId })).length >= 3);
  check('every past day closed', (await DayCloseModel.countDocuments({ shopId })) >= 59);
  check('returns', (await SaleReturnModel.countDocuments({ shopId })) > 0);
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const soon = await BatchModel.countDocuments({ shopId, quantity: { $gt: 0 }, expiryDate: { $gt: now, $lt: new Date(now.getTime() + 45 * 86_400_000) } });
  check('stock that expires soon, for the expiry screens', soon >= 2, String(soon));
  check('customers with udhaar to collect', (await CustomerModel.countDocuments({ shopId, creditBalance: { $gt: 0 } })) > 0);
  const { OldUdhaarModel } = await import('../src/modules/customers/customer.model.js');
  check('old khata udhaar brought in for 3 customers', (await OldUdhaarModel.countDocuments({ shopId, amount: { $gt: 0 } })) === 3);
  check('owner and 3 staff', (await MembershipModel.countDocuments({ shopId, status: 'active' })) === 4);
  const c = first.counts;
  check('the page counts this month and all time', Boolean(c && c.all.bills === bills.filter((b) => b.status !== 'cancelled').length && c.month.bills <= c.all.bills && c.week.bills <= c.month.bills && c.today.bills <= c.week.bills), JSON.stringify(c));

  section('3. The sign-in code: only a super admin sets it; no guessable codes');
  check('support role → 403', (await helper.put('/admin/demo/code', { code: '482916', reason: 'Code for the sales team' })).status === 403);
  check('123456 → 422', (await root.put('/admin/demo/code', { code: '123456', reason: 'Code for the sales team' })).status === 422);
  check('777777 → 422', (await root.put('/admin/demo/code', { code: '777777', reason: 'Code for the sales team' })).status === 422);
  check('five digits → 422', (await root.put('/admin/demo/code', { code: '48291', reason: 'Code for the sales team' })).status === 422);
  check('saved', (await root.put('/admin/demo/code', { code: '482916', reason: 'Code for the sales team' })).status === 200);
  const hash = (await DemoModel.findById('demo').lean())?.codeHash ?? '';
  check('kept as a bcrypt hash, never the code', hash.startsWith('$2') && !hash.includes('482916'));

  const shop = async (otp: string) => {
    const s = h.client();
    await s.post('/auth/otp/request', { email: 'demo@medbox24.in' });
    const r = await s.post('/auth/otp/verify', { email: 'demo@medbox24.in', otp });
    s.shopId = first.shop?.id ?? '';
    return { s, r };
  };
  const { s: demo, r: signed } = await shop('482916');
  check('demo@medbox24.in signs in with the code', signed.status === 200, code(signed));
  const sub = data<{ planName: string; status: string; demo: boolean; readOnly: boolean }>(await demo.get('/subscription'));
  check('plan: demo, free for life, active', sub.demo && sub.status === 'active' && !sub.readOnly && /free for life/.test(sub.planName), JSON.stringify(sub));
  check('no plan payment → 403', (await demo.post('/subscription/order', { planCode: 'monthly' })).status === 403);
  check('no cancelling → 403', (await demo.post('/subscription/cancel', { reason: 'Testing it out' })).status === 403);
  check('no coin purchase → 403', (await demo.post('/ai/coins/order', { packCode: 'small' })).status === 403);
  check('no invitations → 403', (await demo.post('/staff', { email: 'someone@example.com', name: 'Someone', roleId: new Types.ObjectId().toHexString() })).status === 403);
  check('billing works as in any shop', (await demo.get('/sales?limit=5')).status === 200);
  const dues = data<{ name: string; visits: number; balance: number }[]>(await demo.get('/clinic/dues'));
  const banerjee = dues.find((d) => d.name === 'Dr. S. Banerjee');
  check('D90: three doctors sit at the demo shop; Dr. Banerjee saw 18 patients this week, ₹7,200 to give (18 × ₹500 − 20%)', dues.length === 3 && banerjee?.visits === 18 && banerjee.balance === 720_000, JSON.stringify(dues));
  const nextDay = ['', ''].map((_, i) => new Date(Date.now() + 5.5 * 3_600_000 + i * 86_400_000).toISOString().slice(0, 10));
  const boards = await Promise.all(nextDay.map(async (d) => data<{ doctors: { name: string; sittings: { visits: { kind: string }[] }[] }[] }>(await demo.get(`/clinic/day?day=${d}`))));
  const tokens = boards.flatMap((b) => b.doctors.filter((d) => d.name === 'Dr. S. Banerjee').flatMap((d) => d.sittings.flatMap((s) => s.visits)));
  check('…and the next sitting has 4 tokens, one a free follow-up', tokens.length === 4 && tokens.filter((v) => v.kind === 'followup').length === 1, JSON.stringify(tokens.map((v) => v.kind)));
  const staff = h.client();
  await staff.post('/auth/otp/request', { email: 'demo.cashier@medbox24.in' });
  check('the cashier signs in with the same code, to show what a cashier sees', (await staff.post('/auth/otp/verify', { email: 'demo.cashier@medbox24.in', otp: '482916' })).status === 200);
  staff.shopId = demo.shopId;
  check('…bills open, the staff list is the owner’s (403)', (await staff.get('/sales?limit=5')).status === 200 && (await staff.get('/staff')).status === 403);

  section('4. Ten wrong codes lock it; a new code signs every device out');
  const w = h.client();
  await w.post('/auth/otp/request', { email: 'demo@medbox24.in' });
  for (let i = 0; i < 9; i++) await w.post('/auth/otp/verify', { email: 'demo@medbox24.in', otp: String(100_000 + i * 7) });
  check('nine wrong codes: not locked yet', !(await info()).lockedUntil);
  await w.post('/auth/otp/request', { email: 'demo@medbox24.in' });
  await w.post('/auth/otp/verify', { email: 'demo@medbox24.in', otp: '100099' });
  check('locked for an hour', Boolean((await info()).lockedUntil));
  check('the right code no longer works while locked', (await shop('482916')).r.status === 401);
  check('a new code lifts the lock', (await root.put('/admin/demo/code', { code: '730215', reason: 'New code, old one leaked' })).status === 200 && !(await info()).lockedUntil);
  check('the devices signed in with the old code are signed out — owner and staff', (await demo.get('/subscription')).status === 401 && (await staff.get('/sales?limit=5')).status === 401);
  check('the old code is gone', (await shop('482916')).r.status === 401);
  const back = await shop('730215');
  check('the new code works', back.r.status === 200, code(back.r));

  section('5. Platform numbers leave it out; lists mark it');
  const ov = data<{ shops: number }>(await root.get('/admin/overview'));
  check('overview: 0 shops (demo not counted)', ov.shops === 0, JSON.stringify(ov.shops));
  const list = data<{ id: string; demo: boolean }[]>(await root.get('/admin/shops?limit=20'));
  check('shop list marks it DEMO', list.some((x) => x.id === first.shop?.id && x.demo));

  section('6. Through the day the scheduler adds the bills as their time comes; reset makes it again');
  await DemoModel.updateOne({ _id: 'demo' }, { $set: { filledTo: new Date(now.getTime() - 26 * 3_600_000) } });
  const before = await SaleModel.countDocuments({ shopId });
  const kind = await demoTick(new Date());
  const after = await SaleModel.countDocuments({ shopId });
  check('a tick fills the hours since the last fill', kind === 'topup' && after > before, `${String(kind)} ${String(before)} → ${String(after)}`);
  check('reset by support → allowed', (await helper.post('/admin/demo/reset', { reason: 'Client changed things' })).status === 200);
  check('a second reset while one runs → 409', (await root.post('/admin/demo/reset', { reason: 'Client changed things' })).status === 409);
  const again = await settled('reset');
  check('same shop id after reset', again.shop?.id === first.shop?.id);
  const fresh = await SaleModel.countDocuments({ shopId });
  check('the data is made afresh, not added on', Math.abs(fresh - bills.length) < bills.length * 0.1, `${String(bills.length)} → ${String(fresh)}`);
  check('the code survives a reset', (await shop('730215')).r.status === 200);

  await h.close();
  finish();
}

main().catch(crash);
