// D94 checks: a shop asks for <name>.medbox24.in, MedBox24 approves; it opens in the trial, after it only when given free
// (or paid — Razorpay or cash, v1.24.1); the API trusts a live address as the shop app; a name that lapsed 60 days ago can go to another shop.
import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const DAY = 86_400_000;
const sign = (body: string) => createHmac('sha256', 'smoke-razorpay-webhook-secret').update(body).digest('hex');

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});

interface Mine { address: { id: string; name: string; url: string; status: string; live: boolean; reason: string; freeUntil: string | null; paidUntil: string | null } | null; price: number | null; yearPrice: number | null; domain: string; payments: unknown[]; payMode: string }
interface Row { id: string; name: string; status: string; live: boolean; notes: { text: string }[]; owner: { email: string }; shop: { name: string } }
interface Pub { live: boolean; shopName: string | null }

async function main() {
  const h = await startHarness();
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { WebAddressModel } = await import('../src/modules/webaddress/web-address.model.js');
  const { NotificationModel } = await import('../src/modules/notifications/notification.model.js');
  const { totpAt } = await import('../src/utils/totp.js');

  const shop = async (email: string, name: string) => {
    const c = await h.signIn(email);
    c.shopId = data<{ id: string }>(await c.post('/shops', shopBody(name))).id;
    return c;
  };
  const a = await shop('rohit@web1.test', 'Krishna Medical Hall');
  const b = await shop('sunil@web2.test', 'Other Pharmacy');
  const mine = async (c: Client) => data<Mine>(await c.get('/web-address'));
  const pub = async (slug: string) => data<Pub>(await a.get(`/public/web-address/${slug}`));

  await AdminUserModel.create({ email: 'root@medshop.test', name: 'Root', role: 'super' });
  const root = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('root@medshop.test', '135790', 'admin');
  const v = data<{ secret?: string }>(await root.post('/admin/auth/verify', { email: 'root@medshop.test', otp: '135790' }));
  await root.post('/admin/auth/totp', { code: totpAt(v.secret ?? '', Math.floor(Date.now() / 30_000)) });
  const rowOf = async (name: string) => data<{ rows: Row[] }>(await root.get('/admin/web-addresses')).rows.find((r) => r.name === name);
  const reason = 'Called the owner, agreed';

  section('1. Asking for a name');
  check('nothing asked yet; the domain to show', (await mine(a)).address === null && (await mine(a)).domain === 'localhost:3000');
  const short = data<{ ok: boolean; why: string }>(await a.get('/web-address/check?name=ab'));
  check('too short → not ok, says why', !short.ok && short.why === 'At least 3 letters');
  check('ours (admin) → kept for MedBox24', data<{ why: string }>(await a.get('/web-address/check?name=admin')).why === 'This name is kept for MedBox24');
  check('a double hyphen → not ok', !data<{ ok: boolean }>(await a.get('/web-address/check?name=krishna--med')).ok);
  a.lang = 'hi';
  check('the reason comes in the shop’s language', data<{ why: string }>(await a.get('/web-address/check?name=ab')).why === 'कम से कम 3 अक्षर');
  a.lang = undefined;
  check('capitals and spaces around are made small', data<{ name: string; ok: boolean }>(await a.get('/web-address/check?name=%20Krishna-Med%20')).name === 'krishna-med');
  const asked = await a.post('/web-address', { name: 'Krishna-Med' });
  check('asked → requested, not live', asked.status === 200 && data<{ status: string; live: boolean; url: string }>(asked).status === 'requested' && !data<{ live: boolean }>(asked).live && data<{ url: string }>(asked).url === 'http://krishna-med.localhost:3000', code(asked));
  check('another shop can’t ask for it → 409', (await b.post('/web-address', { name: 'krishna-med' })).status === 409);
  check('…and its check says so', data<{ why: string }>(await b.get('/web-address/check?name=krishna-med')).why === 'Another shop has this name');
  check('while waiting the owner may change the name', data<{ name: string }>(await a.post('/web-address', { name: 'krishna' })).name === 'krishna');
  check('the old name is free again', data<{ ok: boolean }>(await b.get('/web-address/check?name=krishna-med')).ok);
  check('take the request back', (await a.del('/web-address')).status === 200 && (await mine(a)).address === null);
  await a.post('/web-address', { name: 'krishna' });

  section('2. Before approval the address is nobody’s app');
  check('public: not live, no name', !(await pub('krishna')).live && (await pub('krishna')).shopName === null);
  const sub = h.client({ origin: 'http://krishna.localhost:3000' });
  const pre = await sub.raw('OPTIONS', '/auth/csrf', undefined, { origin: 'http://krishna.localhost:3000', 'access-control-request-method': 'POST' });
  check('CORS: no allow header for it', !pre.headers.get('access-control-allow-origin'));
  check('a write from it is refused (CSRF origin) → 403', (await sub.post('/auth/otp/request', { email: 'rohit@web1.test' })).status === 403);

  section('3. MedBox24 calls and approves');
  const req = await rowOf('krishna');
  check('admin list: the request, the shop and whom to call', req?.status === 'requested' && req.shop.name === 'Krishna Medical Hall' && req.owner.email === 'rohit@web1.test');
  check('a note from the call', data<Row>(await root.post(`/admin/web-addresses/${req?.id ?? ''}/note`, { text: 'Owner wants it for the counter staff' })).notes.length === 1);
  check('approve without a reason → 422', (await root.post(`/admin/web-addresses/${req?.id ?? ''}/decide`, { action: 'approve', reason: '' })).status === 422);
  const ok = await root.post(`/admin/web-addresses/${req?.id ?? ''}/decide`, { action: 'approve', reason });
  check('approved → live in the trial', ok.status === 200 && data<Row>(ok).live, code(ok));
  check('approving twice → 409', (await root.post(`/admin/web-addresses/${req?.id ?? ''}/decide`, { action: 'approve', reason })).status === 409);
  check('the owner hears of it in the bell', (await NotificationModel.countDocuments({ shopId: a.shopId, type: 'WEB_ADDRESS', title: /krishna\.localhost:3000 is ready/ })) === 1);
  check('public: live with the shop’s name', (await pub('krishna')).live && (await pub('krishna')).shopName === 'Krishna Medical Hall');
  const pre2 = await sub.raw('OPTIONS', '/auth/csrf', undefined, { origin: 'http://krishna.localhost:3000', 'access-control-request-method': 'POST' });
  check('CORS now allows it, with cookies', pre2.headers.get('access-control-allow-origin') === 'http://krishna.localhost:3000' && pre2.headers.get('access-control-allow-credentials') === 'true');
  const otp = await sub.post('/auth/otp/request', { email: 'rohit@web1.test' });
  check('a sign-in from the address passes the origin check', otp.status === 200, code(otp));
  check('an approved address is changed only by MedBox24 → 409', (await a.post('/web-address', { name: 'krishna-two' })).status === 409);
  check('look-alike origins are not trusted', (await h.client({ origin: 'http://krishna.localhost:3000.evil.test' }).post('/auth/otp/request', { email: 'x@y.test' })).status === 403);

  section('4. After the trial: only when given free (or paid)');
  await SubscriptionModel.updateOne({ shopId: a.shopId }, { $set: { planCode: 'pro', status: 'active', endDate: new Date(Date.now() + 30 * DAY) } });
  check('a paid plan without the add-on → the address stops', !(await pub('krishna')).live);
  const until = new Date(Date.now() + 40 * DAY + 5.5 * 3600_000).toISOString().slice(0, 10);
  const free = await root.post(`/admin/web-addresses/${req?.id ?? ''}/free`, { until, reason: 'Launch offer for one year' });
  check('MedBox24 gives it free → live again', free.status === 200 && data<Row>(free).live && (await pub('krishna')).live, code(free));
  check('the shop sees the free time', (await mine(a)).address?.freeUntil?.slice(0, 10) === until);
  const stop = await root.post(`/admin/web-addresses/${req?.id ?? ''}/decide`, { action: 'stop', reason: 'Owner asked to stop' });
  check('stopped → not live, the owner is told why', stop.status === 200 && !(await pub('krishna')).live && (await mine(a)).address?.reason === 'Owner asked to stop');
  check('started again', (await root.post(`/admin/web-addresses/${req?.id ?? ''}/decide`, { action: 'restart', reason })).status === 200 && (await pub('krishna')).live);
  await SubscriptionModel.updateOne({ shopId: a.shopId }, { $set: { endDate: new Date(Date.now() - 30 * DAY) } });
  check('the plan itself ended → the address stops too', !(await pub('krishna')).live);

  section('5. Turned down; a lapsed name goes to another shop');
  await b.post('/web-address', { name: 'other-pharmacy' });
  const bReq = await rowOf('other-pharmacy');
  await root.post(`/admin/web-addresses/${bReq?.id ?? ''}/decide`, { action: 'reject', reason: 'Name looks like a brand' });
  const bMine = await mine(b);
  check('turned down: the owner sees the reason', bMine.address?.status === 'rejected' && bMine.address.reason === 'Name looks like a brand');
  check('a new name may be asked after that', (await b.post('/web-address', { name: 'other-med' })).status === 200);
  check('krishna lapsed only now → still Krishna’s', !data<{ ok: boolean }>(await b.get('/web-address/check?name=krishna')).ok);
  await WebAddressModel.updateOne({ shopId: a.shopId, slug: 'krishna' }, { $set: { freeUntil: new Date(Date.now() - 61 * DAY) } });
  await b.del('/web-address');
  const taken = await b.post('/web-address', { name: 'krishna' });
  check('61 days after it lapsed another shop may ask for it', taken.status === 200, code(taken));
  check('…and Krishna’s old address is released', (await mine(a)).address === null && (await WebAddressModel.countDocuments({ shopId: a.shopId, status: 'released' })) === 1);

  section('6. Price and who may do what');
  check('no price set → the shop sees none', (await mine(b)).price === null);
  check('price needs a reason → 422', (await root.put('/admin/web-addresses/price', { price: 9900 })).status === 422);
  check('MedBox24 sets ₹99 a month', data<{ price: number }>(await root.put('/admin/web-addresses/price', { price: 9900, reason: 'Add-on price from today' })).price === 9900 && (await mine(b)).price === 9900);
  const roles = data<{ id: string; key: string | null }[]>(await a.get('/roles'));
  await a.post('/staff', { email: 'meena@web1.test', name: 'Meena', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('meena@web1.test');
  const inv = data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? '';
  await cashier.post(`/invitations/${inv}/accept`, { name: 'Meena' });
  cashier.shopId = a.shopId;
  check('a cashier can’t ask for an address → 403', (await cashier.post('/web-address', { name: 'meena-shop' })).status === 403);
  const extra = await b.post('/web-address', { name: 'abc-shop', extra: 1 });
  check('unknown fields → 422', extra.status === 422, code(extra));
  check('a shop never sees another’s request', (await mine(a)).address === null);
  check('public: an unknown or bad name is simply not live', !(await pub('no-such-shop')).live && !(await pub('--')).live);

  section('7. Paying for the address (v1.24.1)');
  const { WebAddressPaymentModel } = await import('../src/modules/webaddress/web-address.model.js');
  const { endingOf } = await import('../src/modules/webaddress/web-address.service.js');
  const c = await shop('ganga@web3.test', 'Ganga Pharmacy');
  await c.post('/web-address', { name: 'ganga' });
  const g = await rowOf('ganga');
  await root.post(`/admin/web-addresses/${g?.id ?? ''}/decide`, { action: 'approve', reason });
  const yp = await root.put('/admin/web-addresses/price', { price: 9900, yearPrice: 99_000, reason: 'Year price from today' });
  check('MedBox24 sets ₹99 a month and ₹990 a year', data<{ price: number; yearPrice: number }>(yp).yearPrice === 99_000 && (await mine(c)).yearPrice === 99_000, code(yp));
  check('a year price alone is not kept', data<{ yearPrice: number | null }>(await root.put('/admin/web-addresses/price', { price: null, yearPrice: 5000, reason: 'Checking the rule' })).yearPrice === null);
  await root.put('/admin/web-addresses/price', { price: 9900, yearPrice: 99_000, reason: 'Year price from today' });
  check('a shop without an approved address can’t pay → 409', (await b.post('/web-address/order', { period: 'month' })).status === 409);
  check('an unknown period → 422', (await c.post('/web-address/order', { period: 'week' })).status === 422);
  const ord = await c.post('/web-address/order', { period: 'month' });
  const o1 = data<{ orderId: string; amount: number; label: string }>(ord);
  check('order a month: ₹99, GST ₹15.10 inside', ord.status === 201 && o1.amount === 9900 && (await WebAddressPaymentModel.findOne({ razorpayOrderId: o1.orderId }).lean())?.gst === 1510 && o1.label === 'ganga.localhost:3000 · 1 month', code(ord));
  const trialEnd = (await SubscriptionModel.findOne({ shopId: c.shopId }).lean())?.endDate ?? new Date();
  const p1 = await c.post('/web-address/test-pay', { orderId: o1.orderId });
  const p1d = data<{ id: string; invoiceNumber: string; periodStart: string; periodEnd: string }>(p1);
  check('paid in the trial → paid time starts when the trial ends, 30 days', p1.status === 200 && new Date(p1d.periodStart).getTime() === trialEnd.getTime() && new Date(p1d.periodEnd).getTime() === trialEnd.getTime() + 30 * DAY, code(p1));
  check('…with a tax invoice number', /^MS-\d{4}-\d{2}-\d{5}$/.test(p1d.invoiceNumber));
  check('the same payment again → replayed, no more time', data<{ replayed: boolean }>(await c.post('/web-address/test-pay', { orderId: o1.orderId })).replayed && (await mine(c)).address?.paidUntil === p1d.periodEnd);
  const pdf = await c.raw('GET', `/web-address/payments/${p1d.id}/invoice`);
  check('the invoice downloads as a PDF', pdf.status === 200 && pdf.text.startsWith('%PDF'));
  await SubscriptionModel.updateOne({ shopId: c.shopId }, { $set: { planCode: 'pro', status: 'active', endDate: new Date(Date.now() + 30 * DAY) } });
  check('trial over, add-on paid → still live', (await pub('ganga')).live);

  const o2 = data<{ orderId: string }>(await c.post('/web-address/order', { period: 'year' }));
  const hook = h.client({ origin: null });
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WEBYEAR1', order_id: o2.orderId, amount: 99_000, method: 'upi' } } } });
  const w1 = await hook.raw('POST', '/webhooks/razorpay', raw, { 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': 'evt_web_1' });
  const afterYear = (await mine(c)).address?.paidUntil ?? '';
  check('the webhook pays a year → 365 more days after the month', w1.status === 200 && new Date(afterYear).getTime() === new Date(p1d.periodEnd).getTime() + 365 * DAY, code(w1));
  await hook.raw('POST', '/webhooks/razorpay', raw, { 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': 'evt_web_2' });
  check('the same payment in another event → no second year', (await mine(c)).address?.paidUntil === afterYear);
  const o3 = data<{ orderId: string }>(await c.post('/web-address/order', { period: 'month' }));
  const rawShort = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WEBSHORT', order_id: o3.orderId, amount: 100, method: 'upi' } } } });
  await hook.raw('POST', '/webhooks/razorpay', rawShort, { 'x-razorpay-signature': sign(rawShort), 'x-razorpay-event-id': 'evt_web_3' });
  check('₹1 paid on a ₹99 order → failed, no time', (await WebAddressPaymentModel.findOne({ razorpayOrderId: o3.orderId }).lean())?.status === 'failed' && (await mine(c)).address?.paidUntil === afterYear);

  check('cash by hand needs the UTR / receipt → 422', (await root.post(`/admin/web-addresses/${g?.id ?? ''}/payment`, { period: 'month', reference: '', reason })).status === 422);
  const man = await root.post(`/admin/web-addresses/${g?.id ?? ''}/payment`, { period: 'month', reference: 'CASH-0412', reason: 'Owner paid cash at the shop' });
  const manRow = data<{ paidUntil: string; payments: { source: string; reference: string }[] }>(man);
  check('MedBox24 records cash → 30 more days, on the admin row', man.status === 200 && new Date(manRow.paidUntil).getTime() === new Date(afterYear).getTime() + 30 * DAY && manRow.payments[0]?.source === 'manual' && manRow.payments[0].reference === 'CASH-0412', code(man));
  const cm = await mine(c);
  check('the shop sees 3 paid payments, online in test mode', cm.payments.length === 3 && cm.payMode === 'test');
  check('another shop never sees them', (await mine(b)).payments.length === 0);

  await WebAddressModel.updateOne({ shopId: c.shopId, slug: 'ganga' }, { $set: { paidUntil: new Date(Date.now() + 3 * DAY - 60_000) } });
  const soon = await endingOf(new Types.ObjectId(c.shopId), new Date());
  check('3 days left → the owner’s bell says so', soon?.left === 3 && soon.live);
  await WebAddressModel.updateOne({ shopId: c.shopId, slug: 'ganga' }, { $set: { paidUntil: new Date(Date.now() - DAY) } });
  const gone = await endingOf(new Types.ObjectId(c.shopId), new Date());
  check('ran out → paused, pay to turn it on', gone?.live === false && !(await pub('ganga')).live);
  const back = data<{ orderId: string }>(await c.post('/web-address/order', { period: 'month' }));
  await c.post('/web-address/test-pay', { orderId: back.orderId });
  check('paid again after it ran out → 30 days from today, live again', (await pub('ganga')).live && Math.abs(new Date((await mine(c)).address?.paidUntil ?? 0).getTime() - (Date.now() + 30 * DAY)) < 60_000);
  await root.post(`/admin/web-addresses/${g?.id ?? ''}/decide`, { action: 'stop', reason: 'Owner asked to stop' });
  check('a stopped address can’t be paid for → 409', (await c.post('/web-address/order', { period: 'month' })).status === 409);

  await h.close();
  finish();
}

main().catch(crash);
