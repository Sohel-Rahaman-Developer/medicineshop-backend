// D90 checks: a doctor's chamber at the shop — sittings, tokens, free follow-ups, fees held for the doctor less the
// shop's commission, payouts, the doctor not coming, the day close, the Pro lock and another shop's walls.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error as { details?: { reason?: string } } | undefined)?.details?.reason ?? '';

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const DAY = 86_400_000;
const ist = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);

interface Visit { id: string; token: number; time: string; status: string; fee: number; paid: number; due: number; kind: string; customerId: string | null; day: string; start: string; patient: { name: string } }
interface Slot { day: string; start: string; left: number; nextToken: number; time: string; off: boolean }
interface Due { id: string; fees: number; commission: number; earned: number; paidOut: number; balance: number; visits: number; notCollected: number; advanceHeld: number }

async function main() {
  const h = await startHarness();
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { forgetPlanFeatures } = await import('../src/modules/subscription/plan-access.js');
  const { CustomerModel } = await import('../src/modules/customers/customer.model.js');
  const today = ist(Date.now());
  const tomorrow = ist(Date.now() + DAY);
  const later = ist(Date.now() + 2 * DAY);

  const owner = await h.signIn('rohit@clinic1.test');
  owner.shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;

  section('1. A doctor and their chamber');
  const doc = data<{ id: string }>(await owner.post('/doctors', { name: 'Dr. S. Banerjee', specialization: 'Physician', registrationNumber: 'WBMC 4471', phone: '', clinic: '' }));
  const every = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, start: '00:00', end: '23:59', max: 3 }));
  const chamber = { fee: 50_000, freeDays: 7, commission: { mode: 'pct', value: 20 }, minutes: 10, sittings: every };
  const bad = [
    await owner.put(`/clinic/doctors/${doc.id}/chamber`, { ...chamber, sittings: [{ day: 1, start: '18:00', end: '20:00', max: 10 }, { day: 1, start: '19:00', end: '21:00', max: 10 }] }),
    await owner.put(`/clinic/doctors/${doc.id}/chamber`, { ...chamber, commission: { mode: 'pct', value: 120 } }),
    await owner.put(`/clinic/doctors/${doc.id}/chamber`, { ...chamber, commission: { mode: 'flat', value: 60_000 } }),
    await owner.put(`/clinic/doctors/${doc.id}/chamber`, { ...chamber, sittings: [{ day: 1, start: '20:00', end: '19:00', max: 10 }] }),
  ];
  check('overlapping sittings, 120%, commission above the fee and a sitting ending before it starts → 422', bad.every((r) => r.status === 422), bad.map(code).join(' | '));
  check('chamber saved: ₹500, 7 free days, shop keeps 20%, every day 00:00–23:59 for 3', (await owner.put(`/clinic/doctors/${doc.id}/chamber`, chamber)).status === 200);
  const listed = data<{ id: string; chamber: { fee: number } | null }[]>(await owner.get('/doctors')).find((d) => d.id === doc.id);
  check('the doctors list carries the chamber', listed?.chamber?.fee === 50_000);
  const renamed = await owner.put(`/doctors/${doc.id}`, { name: 'Dr. Sunil Banerjee', specialization: 'Physician', registrationNumber: 'WBMC 4471', phone: '98300 55555', clinic: '' });
  check('the doctor can be edited (name, phone)', renamed.status === 200 && data<{ name: string }>(renamed).name === 'Dr. Sunil Banerjee', code(renamed));

  section('2. Sittings to book and tokens');
  const s1 = data<{ slots: Slot[] }>(await owner.get(`/clinic/slots?doctorId=${doc.id}&days=7`)).slots;
  check('7 coming sittings, today first, 3 places, token 1 at 00:00', s1.length === 7 && s1[0]?.day === today && s1[0].left === 3 && s1[0].nextToken === 1 && s1[0].time === '00:00', JSON.stringify(s1[0]));
  const book = (body: Record<string, unknown>) => owner.post('/clinic/visits', { clientRequestId: crypto.randomUUID(), doctorId: doc.id, day: today, start: '00:00', phone: '98311 22334', bookerName: 'Tapas Chatterjee', patient: { name: 'Tapas Chatterjee', age: 54, gender: 'male' }, kind: 'new', fee: 50_000, note: '', ...body });
  const r1 = await book({ payMode: 'CASH' });
  const v1 = data<Visit>(r1);
  check('booked, paid ₹500 in cash: token 1', r1.status === 201 && v1.token === 1 && v1.paid === 50_000 && v1.due === 0, code(r1));
  const c = await CustomerModel.findOne({ shopId: owner.shopId, phone: '+919831122334' }).lean();
  check('a new phone becomes a customer named after who booked', c?.name === 'Tapas Chatterjee' && v1.customerId === String(c._id));
  const v2 = data<Visit>(await book({ patient: { name: 'Rina Chatterjee', age: 50, gender: 'female' } }));
  check('his wife on the same phone, pay at the visit: token 2 at 00:10, ₹500 due', v2.token === 2 && v2.time === '00:10' && v2.due === 50_000 && v2.customerId === v1.customerId);
  const v3 = data<Visit>(await book({ phone: '98300 77777', bookerName: '', patient: { name: 'Farida Begum', age: null, gender: '' } }));
  const full = await book({ phone: '98300 88888', patient: { name: 'Someone Else', age: null, gender: '' } });
  check('3 places: the 4th is refused (FULL)', v3.token === 3 && full.status === 409 && reason(full) === 'FULL', code(full));
  const past = await book({ day: ist(Date.now() - DAY) });
  const notSitting = await book({ start: '07:00' });
  check('yesterday and a time the doctor doesn’t sit → 422', past.status === 422 && notSitting.status === 422, `${code(past)} | ${code(notSitting)}`);

  section('3. At the counter: who is on this phone');
  const look = data<{ customer: { name: string } | null; patients: { name: string; age: number | null }[] }>(await owner.get(`/clinic/lookup?phone=98311%2022334&doctorId=${doc.id}`));
  check('the phone finds Tapas and both patients booked on it', look.customer?.name === 'Tapas Chatterjee' && look.patients.map((p) => p.name).sort().join() === 'Rina Chatterjee,Tapas Chatterjee');

  section('4. Arrived, seen, paid, cancelled');
  const st = (v: Visit, status: string) => owner.post(`/clinic/visits/${v.id}/status`, { status });
  check('Tapas arrives, then is seen', (await st(v1, 'arrived')).status === 200 && data<Visit>(await st(v1, 'seen')).status === 'seen');
  const wrong = await st(v1, 'no_show');
  check('a seen patient can’t become a no-show (409)', wrong.status === 409, code(wrong));
  const paidUpi = await owner.post(`/clinic/visits/${v2.id}/pay`, { mode: 'UPI' });
  check('Rina pays ₹500 by UPI at the visit', data<Visit>(paidUpi).paid === 50_000 && (await owner.post(`/clinic/visits/${v2.id}/pay`, { mode: 'CASH' })).status === 409);
  await st(v2, 'seen');
  check('Farida cancels (nothing paid)', data<Visit>(await owner.post(`/clinic/visits/${v3.id}/cancel`, { reason: 'Feeling better' })).status === 'cancelled');
  const again = await book({ phone: '98300 88888', patient: { name: 'Someone Else', age: null, gender: '' } });
  check('her place opens again — the new booking takes token 4 (tokens are never reused)', data<Visit>(again).token === 4, code(again));
  const v4 = data<Visit>(again);
  const paid4 = data<Visit>(await owner.post(`/clinic/visits/${v4.id}/pay`, { mode: 'CASH' }));
  const noRefund = await owner.post(`/clinic/visits/${v4.id}/cancel`, { reason: 'Doctor late' });
  const refunded = await owner.post(`/clinic/visits/${v4.id}/cancel`, { reason: 'Doctor late', refundMode: 'CASH' });
  check('a paid booking cancels only with how the fee goes back; then paid is 0', paid4.paid === 50_000 && noRefund.status === 422 && data<Visit>(refunded).paid === 0, `${code(noRefund)} | ${code(refunded)}`);

  section('5. Coming back with the report: free within 7 days');
  const fu = data<{ patients: { name: string; followUp: { free: boolean; daysAgo: number } | null }[] }>(await owner.get(`/clinic/lookup?phone=98311%2022334&doctorId=${doc.id}&day=${tomorrow}`));
  const tapas = fu.patients.find((p) => p.name === 'Tapas Chatterjee');
  check('tomorrow Tapas is due a free follow-up (seen 1 day ago)', tapas?.followUp?.free === true && tapas.followUp.daysAgo === 1, JSON.stringify(tapas));
  const f1 = data<Visit>(await book({ day: tomorrow, kind: 'followup', fee: 0 }));
  check('booked as a follow-up for ₹0, nothing due', f1.kind === 'followup' && f1.fee === 0 && f1.due === 0);
  const feeUp = await owner.post(`/clinic/visits/${f1.id}/fee`, { kind: 'new', fee: 50_000 });
  check('staff can still charge it as a new visit before anything is paid', data<Visit>(feeUp).fee === 50_000 && data<Visit>(feeUp).due === 50_000, code(feeUp));

  section('6. Moving, and the doctor not coming');
  const moved = await owner.post(`/clinic/visits/${f1.id}/move`, { day: later, start: '00:00' });
  check('moved to the day after: token 1 there', data<Visit>(moved).day === later && data<Visit>(moved).token === 1, code(moved));
  await book({ day: later, phone: '98300 66666', patient: { name: 'Kakoli Ghosh', age: 30, gender: 'female' }, payMode: 'UPI' });
  const off = data<{ cancelled: { patient: string; phone: string }[]; paid: { patient: string }[] }>(await owner.post('/clinic/off', { doctorId: doc.id, day: later, start: '00:00', reason: 'Out of town' }));
  check('doctor not coming: the unpaid one is cancelled, the paid one waits to be given back or moved', off.cancelled.map((x) => x.patient).join() === 'Tapas Chatterjee' && off.paid.map((x) => x.patient).join() === 'Kakoli Ghosh', JSON.stringify(off));
  const blocked = await book({ day: later, phone: '98300 99999', patient: { name: 'New Person', age: null, gender: '' } });
  const slotOff = data<{ slots: Slot[] }>(await owner.get(`/clinic/slots?doctorId=${doc.id}&from=${later}&days=1`)).slots[0];
  check('no new bookings in that sitting (SITTING_OFF), and the booking list says so', blocked.status === 409 && reason(blocked) === 'SITTING_OFF' && slotOff?.off === true, code(blocked));
  check('opened again: booking works', (await owner.post('/clinic/on', { doctorId: doc.id, day: later, start: '00:00' })).status === 200 && (await book({ day: later, phone: '98300 99999', patient: { name: 'New Person', age: null, gender: '' } })).status === 201);
  const board = data<{ doctors: { name: string; sittings: { booked: number; max: number; visits: { token: number; status: string }[] }[] }[] }>(await owner.get(`/clinic/day?day=${today}`));
  check('today’s board: one doctor, one sitting, tokens 1–4 with their states', board.doctors.length === 1 && board.doctors[0]?.sittings[0]?.visits.map((v) => `${String(v.token)}${v.status}`).join() === '1seen,2seen,3cancelled,4cancelled', JSON.stringify(board.doctors[0]?.sittings[0]?.visits));

  section('7. What the shop holds for the doctor, and paying out');
  const d1 = (data<Due[]>(await owner.get('/clinic/dues')))[0];
  check('2 seen × ₹500 = ₹1,000; shop keeps 20% = ₹200; ₹800 for the doctor; Kakoli’s ₹500 advance held, not yet his', d1?.visits === 2 && d1.fees === 100_000 && d1.commission === 20_000 && d1.earned === 80_000 && d1.balance === 80_000 && d1.advanceHeld === 50_000, JSON.stringify(d1));
  const over = await owner.post('/clinic/payouts', { clientRequestId: crypto.randomUUID(), doctorId: doc.id, amount: 90_000, mode: 'CASH', fromDrawer: true, note: '' });
  const p1 = await owner.post('/clinic/payouts', { clientRequestId: crypto.randomUUID(), doctorId: doc.id, amount: 30_000, mode: 'CASH', fromDrawer: true, note: 'This week' });
  const d2 = (data<Due[]>(await owner.get('/clinic/dues')))[0];
  check('more than is due is refused; ₹300 paid from the drawer leaves ₹500', over.status === 422 && p1.status === 201 && d2?.paidOut === 30_000 && d2.balance === 50_000, `${code(over)} ${code(p1)} ${JSON.stringify(d2)}`);
  const acct = data<{ visits: { toDoctor: number }[]; payouts: { amount: number }[] }>(await owner.get(`/clinic/dues/${doc.id}`));
  check('the doctor’s account lists the visits (₹400 each to him) and the payout', acct.visits.length === 2 && acct.visits.every((v) => v.toDoctor === 40_000) && acct.payouts[0]?.amount === 30_000);

  section('8. The day close counts the drawer cash');
  const cash = data<{ cash: { doctorFees: number; doctorOut: number; expected: number } | null }>(await owner.get(`/day-close?day=${today}`)).cash;
  check('fees in cash today: ₹500 (Tapas) + ₹500 (token 4) = ₹1,000; out: ₹500 refund + ₹300 payout = ₹800', cash?.doctorFees === 100_000 && cash.doctorOut === 80_000, JSON.stringify(cash));

  section('9. Pro only, and another shop sees nothing');
  const other = await h.signIn('kakoli@clinic2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Kakoli Pharmacy'))).id;
  check('another shop: its board is empty, our visit is not found, our doctor’s chamber is not theirs', data<{ doctors: unknown[] }>(await other.get(`/clinic/day?day=${today}`)).doctors.length === 0 && (await other.post(`/clinic/visits/${v2.id}/status`, { status: 'arrived' })).status === 404 && (await other.put(`/clinic/doctors/${doc.id}/chamber`, chamber)).status === 404);
  await SubscriptionModel.updateOne({ shopId: owner.shopId }, { $set: { planCode: 'basic-monthly', status: 'active', endDate: new Date(Date.now() + 30 * DAY) } });
  forgetPlanFeatures();
  const lock = await owner.get(`/clinic/day?day=${today}`);
  check('Basic: the chamber is a Pro module (403 PLAN_UPGRADE), the doctors list stays open for H1 bills', lock.status === 403 && lock.json.error?.code === 'PLAN_UPGRADE' && (await owner.get('/doctors')).status === 200, code(lock));

  finish();
}

main().catch(crash);
