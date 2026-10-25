// v1.26 checks: a shop's own domain — one it has (DNS points here, the team switches it on) or one MedBox24 buys (price
// after the call, paid in the app every year). It opens that shop only; from the main site a one-time code signs you in there.
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const DAY = 86_400_000;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});

interface Dom { id: string; domain: string; url: string; kind: string; status: string; live: boolean; buyPrice: number | null; domainPaidUntil: string | null; paidUntil: string | null; dnsOk: boolean }
interface Own { domain: Dom | null; serverIp: string }
interface Row extends Dom { notes: unknown[]; payments: { what: string; amount: number }[] }
interface MeShop { shopId: string; address: string | null; addresses: string[]; handoff: boolean }

async function main() {
  const h = await startHarness();
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { OwnDomainModel } = await import('../src/modules/owndomain/own-domain.model.js');
  const { HandoffModel } = await import('../src/modules/auth/models/handoff.model.js');
  const { NotificationModel } = await import('../src/modules/notifications/notification.model.js');
  const { UserModel } = await import('../src/modules/user/user.model.js');
  const { setDnsLookup, domainEndingOf, forgetLiveDomains } = await import('../src/modules/owndomain/own-domain.service.js');
  const { totpAt } = await import('../src/utils/totp.js');

  // DNS stand-in: this server is 10.0.0.1; a name points here once it is in the map.
  const dns = new Map<string, string[]>([['localhost', ['10.0.0.1']]]);
  setDnsLookup((host) => Promise.resolve(dns.get(host) ?? []));
  const pointHere = (d: string) => { dns.set(d, ['10.0.0.1']); dns.set(`www.${d}`, ['10.0.0.1']); };

  const shop = async (email: string, name: string) => {
    const c = await h.signIn(email);
    c.shopId = data<{ id: string }>(await c.post('/shops', shopBody(name))).id;
    return c;
  };
  const a = await shop('rohit@dom1.test', 'Krishna Medical Hall');
  const b = await shop('sunil@dom2.test', 'Bharat Pharmacy');
  const own = async (c: Client) => data<{ own: Own }>(await c.get('/web-address')).own;
  const pub = async (host: string) => data<{ live: boolean; shopName: string | null }>(await a.get(`/public/domain/${host}`));

  await AdminUserModel.create({ email: 'root@medshop.test', name: 'Root', role: 'super' });
  const root = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('root@medshop.test', '135790', 'admin');
  const v = data<{ secret?: string }>(await root.post('/admin/auth/verify', { email: 'root@medshop.test', otp: '135790' }));
  await root.post('/admin/auth/totp', { code: totpAt(v.secret ?? '', Math.floor(Date.now() / 30_000)) });
  const rows = async () => data<{ domains: Row[] }>(await root.get('/admin/web-addresses')).domains;
  const rowOf = async (domain: string) => (await rows()).find((r) => r.domain === domain);
  const reason = 'Called the owner, agreed';

  section('1. Asking for a domain the shop has');
  check('nothing asked yet', (await own(a)).domain === null);
  const bad = await a.post('/web-address/domain', { domain: 'krishna', kind: 'own' });
  check('no dot → 422 with why', bad.status === 422 && bad.json.error?.message === 'Type the full domain, like krishnamedical.in', code(bad));
  check('a MedBox24 address → 422', (await a.post('/web-address/domain', { domain: 'krishna.localhost', kind: 'own' })).status === 422);
  check('bad letters → 422', (await a.post('/web-address/domain', { domain: 'krishna_med.in', kind: 'own' })).status === 422);
  const asked = await a.post('/web-address/domain', { domain: 'https://www.Krishna-Med.in/login', kind: 'own' });
  check('asked: https, www, capitals and the path are cleaned → krishna-med.in', asked.status === 200 && data<Dom>(asked).domain === 'krishna-med.in' && data<Dom>(asked).status === 'requested' && data<Dom>(asked).url === 'http://krishna-med.in:3000', code(asked));
  check('another shop can’t ask for it → 409', (await b.post('/web-address/domain', { domain: 'krishna-med.in', kind: 'own' })).status === 409);
  const roles = data<{ id: string; key: string | null }[]>(await a.get('/roles'));
  await a.post('/staff', { email: 'meena@dom1.test', name: 'Meena', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('meena@dom1.test');
  await cashier.post(`/invitations/${data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Meena' });
  cashier.shopId = a.shopId;
  check('a cashier can’t ask → 403', (await cashier.post('/web-address/domain', { domain: 'meena.in', kind: 'own' })).status === 403);

  section('2. DNS, then the team switches it on');
  check('where to point: this server’s IP', (await own(a)).serverIp === '10.0.0.1');
  const d0 = data<{ ok: boolean }>(await a.post('/web-address/domain/dns'));
  check('DNS not pointed yet → not ok', !d0.ok && !(await own(a)).domain?.dnsOk);
  const req = await rowOf('krishna-med.in');
  check('admin list: the request, kind own', req?.status === 'requested' && req.kind === 'own');
  const early = await root.post(`/admin/own-domains/${req?.id ?? ''}/decide`, { action: 'approve', reason });
  check('switch on before the DNS points here → 409, says why', early.status === 409 && /don’t point to this server/.test(early.json.error?.message ?? ''), code(early));
  dns.set('krishna-med.in', ['10.0.0.1']);
  check('only the bare name points here → still not ok (www too)', !data<{ ok: boolean; bare: boolean; www: boolean }>(await a.post('/web-address/domain/dns')).ok);
  pointHere('krishna-med.in');
  check('both point here → ok', data<{ ok: boolean }>(await a.post('/web-address/domain/dns')).ok);
  const on = await root.post(`/admin/own-domains/${req?.id ?? ''}/decide`, { action: 'approve', reason });
  check('switched on → live in the trial', on.status === 200 && data<Row>(on).live, code(on));
  check('the owner hears of it', (await NotificationModel.countDocuments({ shopId: a.shopId, title: 'Your domain krishna-med.in is ready' })) === 1);
  check('public: live with the shop’s name, with or without www', (await pub('krishna-med.in')).shopName === 'Krishna Medical Hall' && (await pub('www.krishna-med.in')).live && !(await pub('other.in')).live);
  check('a switched-on domain is changed only by MedBox24 → 409', (await a.post('/web-address/domain', { domain: 'krishna-two.in', kind: 'own' })).status === 409);

  section('3. It opens this shop only');
  const DOM = 'http://krishna-med.in:3000';
  const at = async (origin: string, email: string) => {
    const cl = h.client({ origin });
    await h.seedOtp(email, '424242');
    return { cl, res: await cl.post('/auth/otp/verify', { email, otp: '424242' }) };
  };
  const mine = await at(DOM, 'rohit@dom1.test');
  check('the owner signs in on the domain (its origin is trusted)', mine.res.status === 200, code(mine.res));
  mine.cl.shopId = a.shopId;
  check('…and works in the shop there', (await mine.cl.raw('GET', '/shop/context', undefined, { origin: DOM })).status === 200);
  const users = await UserModel.countDocuments();
  check('another shop’s owner is refused there, a new email too', (await at(DOM, 'sunil@dom2.test')).res.status === 403 && (await at(DOM, 'new@dom9.test')).res.status === 403 && (await UserModel.countDocuments()) === users);
  check('Bharat’s shop asked from Krishna’s domain → 403', (await b.raw('GET', '/shop/context', undefined, { origin: DOM })).status === 403);
  check('look-alikes are not trusted: another port, a longer name', (await h.client({ origin: 'http://krishna-med.in:4000' }).post('/auth/otp/request', { email: 'x@y.test' })).status === 403 && (await h.client({ origin: 'http://krishna-med.in.evil.test:3000' }).post('/auth/otp/request', { email: 'x@y.test' })).status === 403);
  check('www works as the same domain', (await h.client({ origin: 'http://www.krishna-med.in:3000' }).post('/auth/otp/request', { email: 'rohit@dom1.test' })).status === 200);
  const me = data<{ shops: MeShop[] }>(await a.get('/auth/me')).shops[0];
  check('me: the shop opens on its domain, with a sign-in handoff', me?.address === DOM && me.handoff && me.addresses.join() === DOM, JSON.stringify(me));

  section('4. From the main site to the domain, still signed in');
  const ho = await a.post('/auth/handoff', { to: DOM });
  const hc = data<{ code: string }>(ho).code;
  check('a one-time code for the domain', ho.status === 200 && hc.length >= 40 && (await HandoffModel.countDocuments()) === 1, code(ho));
  check('for a domain that isn’t yours → 403', (await b.post('/auth/handoff', { to: DOM })).status === 403);
  check('for a domain that isn’t live → 403', (await a.post('/auth/handoff', { to: 'http://other.in:3000' })).status === 403);
  const wrong = h.client({ origin: 'http://localhost:3000' });
  check('used on another site → 401', (await wrong.post('/auth/handoff/redeem', { code: hc })).status === 401);
  const ho2 = data<{ code: string }>(await a.post('/auth/handoff', { to: DOM })).code;
  const there = h.client({ origin: DOM });
  const red = await there.post('/auth/handoff/redeem', { code: ho2 });
  check('used on the domain → signed in there (new session cookie)', red.status === 200 && red.setCookies.some((x) => x.startsWith('ms_at=')), code(red));
  there.shopId = a.shopId;
  check('…the shop opens', (await there.raw('GET', '/shop/context', undefined, { origin: DOM })).status === 200);
  check('the same code twice → 401', (await h.client({ origin: DOM }).post('/auth/handoff/redeem', { code: ho2 })).status === 401);
  const ho3 = data<{ code: string }>(await a.post('/auth/handoff', { to: DOM })).code;
  await HandoffModel.updateMany({ usedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  check('after the minute → 401', (await h.client({ origin: DOM }).post('/auth/handoff/redeem', { code: ho3 })).status === 401);
  check('a made-up code → 422 / 401', [401, 422].includes((await h.client({ origin: DOM }).post('/auth/handoff/redeem', { code: 'x'.repeat(43) })).status));

  section('5. A domain MedBox24 buys: price after the call, paid every year');
  const bb = await b.post('/web-address/domain', { domain: 'bharat-pharmacy.com', kind: 'buy' });
  check('asked to buy', bb.status === 200 && data<Dom>(bb).kind === 'buy', code(bb));
  check('paying before the price → 409', (await b.post('/web-address/order', { period: 'year', target: 'domain', what: 'domain' })).status === 409);
  const brow = await rowOf('bharat-pharmacy.com');
  check('an “own” domain has no price to set → 409', (await root.put(`/admin/own-domains/${req?.id ?? ''}/price`, { price: 120_000, reason })).status === 409);
  const pr = await root.put(`/admin/own-domains/${brow?.id ?? ''}/price`, { price: 120_000, reason: 'Registrar price + our work' });
  check('the team sets ₹1,200 a year; the owner is told', pr.status === 200 && data<Row>(pr).buyPrice === 120_000 && (await NotificationModel.countDocuments({ shopId: b.shopId, title: 'bharat-pharmacy.com costs ₹1,200.00 a year' })) === 1, code(pr));
  const o = await b.post('/web-address/order', { period: 'month', target: 'domain', what: 'domain' });
  const od = data<{ orderId: string; amount: number; label: string }>(o);
  check('order: ₹1,200 for a year of the name', o.status === 201 && od.amount === 120_000 && od.label === 'bharat-pharmacy.com · domain for 1 year', code(o));
  const paid = await b.post('/web-address/test-pay', { orderId: od.orderId });
  check('paid → the name is paid for a year', paid.status === 200 && Math.abs(new Date((await own(b)).domain?.domainPaidUntil ?? 0).getTime() - (Date.now() + 365 * DAY)) < 60_000, code(paid));
  check('a paid request can’t be taken back by the shop → 409', (await b.del('/web-address/domain')).status === 409);
  check('switch on before the DNS → 409', (await root.post(`/admin/own-domains/${brow?.id ?? ''}/decide`, { action: 'approve', reason })).status === 409);
  pointHere('bharat-pharmacy.com');
  check('bought, DNS set → switched on and live', data<Row>(await root.post(`/admin/own-domains/${brow?.id ?? ''}/decide`, { action: 'approve', reason })).live);
  const inv = data<{ payments: { id: string; what: string; invoiceNumber: string }[] }>(await b.get('/web-address')).payments.find((x) => x.what === 'domain');
  const pdf = await b.raw('GET', `/web-address/payments/${inv?.id ?? ''}/invoice`);
  check('the domain’s tax invoice downloads', Boolean(inv?.invoiceNumber) && pdf.status === 200 && pdf.text.startsWith('%PDF'));
  const before = (await own(b)).domain?.domainPaidUntil ?? '';
  const man = await root.post(`/admin/own-domains/${brow?.id ?? ''}/payment`, { what: 'domain', period: 'year', reference: 'UPI-77881', reason: 'Owner paid the renewal by UPI' });
  check('the team records next year’s renewal by hand → +365 days', man.status === 200 && new Date((await own(b)).domain?.domainPaidUntil ?? 0).getTime() === new Date(before).getTime() + 365 * DAY, code(man));
  await OwnDomainModel.updateOne({ shopId: b.shopId, domain: 'bharat-pharmacy.com' }, { $set: { domainPaidUntil: new Date(Date.now() + 10 * DAY) } });
  const end = await domainEndingOf(new (await import('mongoose')).Types.ObjectId(b.shopId), new Date());
  check('10 days left on the name → the owner’s bell says so', end?.left === 10);
  await OwnDomainModel.updateOne({ shopId: b.shopId, domain: 'bharat-pharmacy.com' }, { $set: { domainPaidUntil: new Date(Date.now() - DAY) } });
  forgetLiveDomains();
  check('the name not renewed → the domain stops', !(await pub('bharat-pharmacy.com')).live);

  section('6. After the trial: the add-on, like the web address');
  await root.put('/admin/web-addresses/price', { price: 9900, yearPrice: 99_000, reason: 'Add-on price' });
  await SubscriptionModel.updateOne({ shopId: a.shopId }, { $set: { planCode: 'pro', status: 'active', endDate: new Date(Date.now() + 30 * DAY) } });
  forgetLiveDomains();
  check('a paid plan without the add-on → the domain stops; me falls back to none', !(await pub('krishna-med.in')).live && data<{ shops: MeShop[] }>(await a.get('/auth/me')).shops[0]?.address === null);
  const ao = data<{ orderId: string; amount: number; label: string }>(await a.post('/web-address/order', { period: 'month', target: 'domain' }));
  check('order the add-on for the domain: ₹99, 1 month', ao.amount === 9900 && ao.label === 'krishna-med.in:3000 · 1 month', JSON.stringify(ao));
  await a.post('/web-address/test-pay', { orderId: ao.orderId });
  check('paid → live again', (await pub('krishna-med.in')).live);
  check('the admin row shows the payment', (await rowOf('krishna-med.in'))?.payments[0]?.what === 'addon');

  section('7. Stopped');
  await root.post(`/admin/own-domains/${req?.id ?? ''}/decide`, { action: 'stop', reason: 'Owner asked to stop' });
  check('stopped → not live, its origin no longer trusted', !(await pub('krishna-med.in')).live && (await h.client({ origin: DOM }).post('/auth/otp/request', { email: 'rohit@dom1.test' })).status === 403);
  check('a cashier never sees the admin side → the shop still works on the main site', (await cashier.get('/shop/context')).status === 200);

  await h.close();
  finish();
}

main().catch(crash);
