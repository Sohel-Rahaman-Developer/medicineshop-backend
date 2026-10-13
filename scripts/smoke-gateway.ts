// D95 checks: Razorpay keys set in the admin app (never the env) — sealed, last 4 only, test / live / off, the shop
// pays with them, webhooks check them, invoices carry the admin's GSTIN; a local stand-in plays Razorpay.
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});

const TEST = { keyId: 'rzp_test_AbCdEf123456', keySecret: 'tEsTsEcReT0123456789wxyz', webhookSecret: 'hook-test-9f8e7d6c' }; // gitleaks:allow
const LIVE = { keyId: 'rzp_live_ZyXwVu987654', keySecret: 'LiVeSeCrEt9876543210abcd', webhookSecret: 'hook-live-1a2b3c4d' }; // gitleaks:allow
const ENV_HOOK = 'smoke-razorpay-webhook-secret';

interface Seen { method: string; url: string; auth: string }
interface View { active: string | null; mode: string; source: string; test: { keyId: string | null; secretLast4: string | null; webhookLast4: string | null; complete: boolean }; live: { complete: boolean }; billing: { gstin: string; state: string; sac: string; legalName: string }; lastWebhook: { event: string; valid: boolean } | null }

/** Razorpay's answers for the calls MedBox24 makes: good keys get 200, others 401; an unknown order id 400. */
async function startFakeRazorpay() {
  const seen: Seen[] = [];
  const good = new Set([basic(TEST.keyId, TEST.keySecret), basic(LIVE.keyId, LIVE.keySecret)]);
  let n = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      const auth = req.headers.authorization ?? '';
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (!good.has(auth)) {
        send(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/payments')) send(200, { entity: 'collection', count: 0, items: [] });
      else if (req.method === 'POST' && req.url === '/v1/orders') send(200, { id: `order_Fake${String(++n).padStart(8, '0')}` });
      else if (req.method === 'GET' && /^\/v1\/orders\/[^/]+\/payments$/.test(req.url ?? '')) send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
      else send(404, { error: { description: 'not here' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, seen, close: () => new Promise<void>((resolve) => server.close(() => { resolve(); })) };
}

async function main() {
  const fake = await startFakeRazorpay();
  process.env.RAZORPAY_BASE_URL = fake.url;
  const h = await startHarness();
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { GatewaySettingsModel } = await import('../src/modules/subscription/gateway.js');
  const { SubscriptionPaymentModel } = await import('../src/modules/subscription/billing.model.js');
  const { supplier } = await import('../src/modules/subscription/subscription.service.js');
  const { reconcile } = await import('../src/modules/subscription/reconcile.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');
  const step = () => Math.floor(Date.now() / 30_000);

  await AdminUserModel.create([
    { email: 'root@gw.test', name: 'Root', role: 'super' },
    { email: 'acc@gw.test', name: 'Asha Accounts', role: 'accounts' },
    { email: 'view@gw.test', name: 'Vik Viewer', role: 'viewer' },
  ]);
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const r = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' }));
    await c.post('/admin/auth/totp', { code: totpAt(r.secret ?? '', step()) });
    return c;
  };
  const root = await login('root@gw.test');
  const acc = await login('acc@gw.test');
  const viewer = await login('view@gw.test');
  const owner = await h.signIn('rohit@gw1.test');
  owner.shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  const view = async () => data<View>(await root.get('/admin/gateway'));
  const shopSees = async () => data<{ payments: string; keyId: string | null }>(await owner.get('/subscription'));
  const hook = h.client({ origin: null });
  const sendHook = (raw: string, sig: string, id: string) => hook.raw('POST', '/webhooks/razorpay', raw, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': id });

  section('1. Before the admin saves anything: the server env, as before');
  const v0 = await view();
  check('nothing saved → the env runs payments (test mode here)', v0.source === 'env' && v0.active === null && v0.mode === 'test', JSON.stringify(v0));
  check('accounts can look; a viewer can’t → 403', (await acc.get('/admin/gateway')).status === 200 && (await viewer.get('/admin/gateway')).status === 403);
  check('the shop’s plan screen still says test mode', (await shopSees()).payments === 'test');

  section('2. Saving keys: super only, checked, sealed, last 4 only');
  check('accounts can’t save keys → 403', (await acc.put('/admin/gateway/keys/test', { ...TEST, reason: 'Razorpay test keys' })).status === 403);
  check('a live key ID in the test slot → 422', (await root.put('/admin/gateway/keys/test', { ...TEST, keyId: LIVE.keyId, reason: 'Razorpay test keys' })).status === 422);
  check('not a Razorpay key ID → 422', (await root.put('/admin/gateway/keys/test', { ...TEST, keyId: 'pk_test_123456789', reason: 'Razorpay test keys' })).status === 422);
  check('no reason → 422', (await root.put('/admin/gateway/keys/test', TEST)).status === 422);
  const noSecret = await root.put('/admin/gateway/keys/test', { keyId: TEST.keyId, webhookSecret: TEST.webhookSecret, reason: 'Razorpay test keys' });
  check('the first save without the key secret → 422', noSecret.status === 422, code(noSecret));
  const saved = await root.put('/admin/gateway/keys/test', { ...TEST, reason: 'Razorpay test keys' });
  const v1 = data<View>(saved);
  check('saved: key ID shown, secrets only as their last 4', saved.status === 200 && v1.test.keyId === TEST.keyId && v1.test.secretLast4 === 'wxyz' && v1.test.webhookLast4 === '7d6c' && v1.test.complete, code(saved));
  check('the answer never carries a secret', !JSON.stringify(saved.json).includes(TEST.keySecret) && !JSON.stringify(saved.json).includes(TEST.webhookSecret));
  const doc = JSON.stringify(await GatewaySettingsModel.findById('razorpay').lean());
  check('the database holds them sealed, never in plain text', !doc.includes(TEST.keySecret) && !doc.includes(TEST.webhookSecret));
  const logged = await AdminAuditModel.findOne({ action: 'gateway_keys_set' }).lean();
  check('the audit log has who, why and the last 4 — not the secret', logged?.reason === 'Razorpay test keys' && logged.text.includes('…wxyz') && !logged.text.includes(TEST.keySecret));
  check('saving keys alone changes nothing yet: still the env', (await view()).source === 'env');
  const keepSecret = await root.put('/admin/gateway/keys/test', { keyId: TEST.keyId, reason: 'same keys, new note' });
  check('a later save with the secrets blank keeps them', keepSecret.status === 200 && data<View>(keepSecret).test.secretLast4 === 'wxyz', code(keepSecret));

  section('3. Test the keys against Razorpay');
  const ok = data<{ ok: boolean; message: string }>(await root.post('/admin/gateway/keys/test/test', {}));
  check('good keys → Razorpay accepts them', ok.ok && fake.seen.at(-1)?.auth === basic(TEST.keyId, TEST.keySecret), ok.message);
  check('live keys not saved yet → 422', (await root.post('/admin/gateway/keys/live/test', {})).status === 422);
  await root.put('/admin/gateway/keys/live', { keyId: LIVE.keyId, keySecret: 'WrOnGsEcReT000000000zzzz', webhookSecret: LIVE.webhookSecret, reason: 'Razorpay live keys' });
  const refused = data<{ ok: boolean; message: string }>(await root.post('/admin/gateway/keys/live/test', {}));
  check('a wrong secret → “Razorpay refused the live keys”', !refused.ok && refused.message.includes('refused'), refused.message);

  section('4. Switch to the test keys: the shop pays with them');
  check('accounts can’t switch → 403', (await acc.put('/admin/gateway/active', { active: 'test', reason: 'start test payments' })).status === 403);
  const on = await root.put('/admin/gateway/active', { active: 'test', reason: 'start test payments' });
  check('switched: the admin’s test keys run payments', on.status === 200 && data<View>(on).source === 'admin' && data<View>(on).mode === 'razorpay', code(on));
  const sees = await shopSees();
  check('the shop’s Checkout gets the saved key ID', sees.payments === 'razorpay' && sees.keyId === TEST.keyId, JSON.stringify(sees));
  const before = fake.seen.length;
  const order = await owner.post('/subscription/order', { planCode: 'monthly' });
  const call = fake.seen.slice(before).find((s) => s.url === '/v1/orders');
  check('a plan order goes to Razorpay with the saved keys', order.status === 201 && data<{ orderId: string }>(order).orderId.startsWith('order_Fake') && call?.auth === basic(TEST.keyId, TEST.keySecret), code(order));
  const raw = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_X1', order_id: 'order_none', amount: 100 } } } });
  check('a webhook signed with the old env secret → 400', (await sendHook(raw, sign(ENV_HOOK, raw), 'evt_gw_1')).status === 400);
  check('signed with the saved test webhook secret → taken', (await sendHook(raw, sign(TEST.webhookSecret, raw), 'evt_gw_2')).status === 200);
  check('the admin sees the last webhook and that it was signed right', (await view()).lastWebhook?.valid === true);
  check('the switch is in the audit log', Boolean(await AdminAuditModel.exists({ action: 'gateway_switched', reason: 'start test payments' })));
  check('keys in use can’t be removed → 409', (await root.del('/admin/gateway/keys/test', { reason: 'clean up old keys' })).status === 409);

  section('5. Another account’s order id skips, never stops the hourly check');
  await SubscriptionPaymentModel.create({ shopId: new Types.ObjectId(owner.shopId), planCode: 'monthly', planName: 'Pro Monthly', durationDays: 30, maxUsers: 5, amount: 79_900, gst: 12_188, razorpayOrderId: 'order_FromOtherAcct', status: 'created', source: 'razorpay', createdBy: new Types.ObjectId(), createdByName: 'Rohit' });
  await SubscriptionPaymentModel.updateOne({ razorpayOrderId: 'order_FromOtherAcct' }, { $set: { createdAt: new Date(Date.now() - 30 * 60_000) } }, { timestamps: false });
  const rec = await reconcile().then((r) => ({ r, threw: false }), () => ({ r: null, threw: true }));
  check('Razorpay refuses that id → reconcile carries on', !rec.threw && rec.r?.orders === 0, JSON.stringify(rec));

  section('6. Live needs the invoice details; then off');
  check('a GSTIN that isn’t one → 422', (await root.put('/admin/gateway/billing', { gstin: '19ABC', state: 'West Bengal', sac: '998314', reason: 'our GST number' })).status === 422);
  check('a state not on the list → 422', (await root.put('/admin/gateway/billing', { gstin: '19AABCM1234A1Z5', state: 'Atlantis', sac: '998314', reason: 'our GST number' })).status === 422);
  const bill = await root.put('/admin/gateway/billing', { gstin: '19aabcm9999b1z2', state: 'West Bengal', sac: '998315', reason: 'our GST number' });
  check('GSTIN saved (in capitals), state and SAC', bill.status === 200 && data<View>(bill).billing.gstin === '19AABCM9999B1Z2' && data<View>(bill).billing.sac === '998315', code(bill));
  const from = await supplier();
  check('new invoices carry the admin’s GSTIN and state code', from.gstin === '19AABCM9999B1Z2' && from.stateCode === '19', JSON.stringify(from));
  await root.put('/admin/gateway/keys/live', { ...LIVE, reason: 'right live keys' });
  const live = await root.put('/admin/gateway/active', { active: 'live', reason: 'go live today' });
  check('live keys + legal name, address and GSTIN → live', live.status === 200 && data<View>(live).active === 'live', code(live));
  check('the shop now gets the live key ID', (await shopSees()).keyId === LIVE.keyId);
  check('the test webhook secret no longer works on live', (await sendHook(raw, sign(TEST.webhookSecret, raw), 'evt_gw_3')).status === 400);
  const off = await root.put('/admin/gateway/active', { active: 'off', reason: 'pause online payments' });
  check('off → the shop sees no online payment', off.status === 200 && (await shopSees()).payments === 'off', code(off));
  check('…and can’t start one → 503', (await owner.post('/subscription/order', { planCode: 'monthly' })).status === 503);
  const removed = await root.del('/admin/gateway/keys/test', { reason: 'clean up old keys' });
  check('keys not in use can be removed', removed.status === 200 && !data<View>(removed).test.complete, code(removed));
  check('switching to keys that aren’t there → 422', (await root.put('/admin/gateway/active', { active: 'test', reason: 'back to test' })).status === 422);

  await h.close();
  await fake.close();
  finish();
}

main().catch(crash);
