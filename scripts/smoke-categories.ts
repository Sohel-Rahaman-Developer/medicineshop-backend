// v1.22.11 checks: a shop asks for a category, MedBox24 approves it once (email link or console), every shop gets it.
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
type Cat = { id: string; name: string; isSystem: boolean };
type Ask = { id: string; name: string; status: string; reason: string };
type Page = { name: string; status: string; shops: { shopName: string; userName: string }[]; decidedBy: string | null; expired: boolean; existing: string[] };

async function main() {
  const h = await startHarness();
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { EmailJobModel } = await import('../src/services/mail-queue.js');
  const { CategoryRequestModel } = await import('../src/modules/categories/category-request.model.js');
  const { NotificationModel } = await import('../src/modules/notifications/notification.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const step = () => Math.floor(Date.now() / 30_000);

  await AdminUserModel.create({ email: 'root@cat.test', name: 'Root', role: 'super' });
  await AdminUserModel.create({ email: 'asha@cat.test', name: 'Asha', role: 'super' });
  await AdminUserModel.create({ email: 'help@cat.test', name: 'Help Desk', role: 'support' });
  await AdminUserModel.create({ email: 'gone@cat.test', name: 'Gone', role: 'super', status: 'disabled' });
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const s = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' })).secret ?? '';
    await c.post('/admin/auth/totp', { code: totpAt(s, step()) });
    return c;
  };

  const a = await h.signIn('rohit@cat1.test');
  a.shopId = data<{ id: string }>(await a.post('/shops', shopBody('Shri Ram Medical'))).id;
  const b = await h.signIn('mita@cat2.test');
  b.shopId = data<{ id: string }>(await b.post('/shops', shopBody('Sen Pharmacy'))).id;
  const link = h.client({ origin: 'http://localhost:3001' });

  section('1. A shop asks; the super admins get one email each');
  const ask = await a.post('/categories', { name: 'Eye drops' });
  check('ask “Eye drops” → 202 pending', ask.status === 202 && data<{ status: string }>(ask).status === 'pending', code(ask));
  check('the message says it waits for MedBox24', /MedBox24/.test(ask.json.message ?? ''));
  check('not usable yet: not in the shop’s list', !data<Cat[]>(await a.get('/categories')).some((c) => c.name === 'Eye drops'));
  check('the shop sees it waiting', data<Ask[]>(await a.get('/categories/requests')).some((r) => r.name === 'Eye drops' && r.status === 'pending'));
  const mails = await EmailJobModel.find({ kind: 'category_request' }).lean();
  check('one email to each active super admin (not support, not disabled)', mails.length === 2 && mails.map((m) => m.to).sort().join() === 'asha@cat.test,root@cat.test', mails.map((m) => m.to).join());
  const tokenOf = (to: string) => /category-request\/([A-Za-z0-9_-]{32})/.exec(mails.find((m) => m.to === to)?.text ?? '')?.[1] ?? '';
  const rootLink = tokenOf('root@cat.test');
  const ashaLink = tokenOf('asha@cat.test');
  check('each admin has an own link', rootLink.length === 32 && ashaLink.length === 32 && rootLink !== ashaLink);
  const stored = await CategoryRequestModel.findOne({ key: 'eyedrop' }).lean();
  check('links are stored hashed, never plain', Boolean(stored) && !JSON.stringify(stored).includes(rootLink));

  section('2. The same category again is not a second request');
  const again = await b.post('/categories', { name: ' EYE-DROP ' });
  check('another shop asks “EYE-DROP” → 202, joins the first ask', again.status === 202 && data<{ already: boolean }>(again).already, code(again));
  check('no new email', (await EmailJobModel.countDocuments({ kind: 'category_request' })) === 2);
  check('a built-in name is refused → 409', (await a.post('/categories', { name: 'tablets' })).status === 409);

  section('3. The link page: the ask, who asked, and what exists');
  const page = await link.get(`/public/category-requests/${rootLink}`);
  const pg = data<Page>(page);
  check('link opens without signing in → 200', page.status === 200, code(page));
  check('shows the name, both shops and the built-in list', pg.name === 'Eye drops' && pg.shops.length === 2 && pg.existing.includes('Tablet') && !pg.expired);
  check('a made-up link → 404', (await link.get(`/public/category-requests/${'x'.repeat(32)}`)).status === 404);
  check('a malformed link → 422', (await link.get('/public/category-requests/abc')).status === 422);
  check('opening the page changes nothing', (await CategoryRequestModel.findOne({ key: 'eyedrop' }).lean())?.status === 'pending');

  section('4. One tap approves it for every shop');
  const ok = await link.post(`/public/category-requests/${rootLink}`, { decision: 'approve' });
  check('approve from the link → 200', ok.status === 200, code(ok));
  check('shop A has it now, built-in (can’t be removed)', data<Cat[]>(await a.get('/categories')).some((c) => c.name === 'Eye drops' && c.isSystem));
  check('shop B has it too', data<Cat[]>(await b.get('/categories')).some((c) => c.name === 'Eye drops'));
  const c = await h.signIn('new@cat3.test');
  c.shopId = data<{ id: string }>(await c.post('/shops', shopBody('Naya Medical'))).id;
  check('a shop made later gets it at once', data<Cat[]>(await c.get('/categories')).some((x) => x.name === 'Eye drops'));
  check('16 built-in + 1 approved on the new shop', data<Cat[]>(await c.get('/categories')).length === 17);
  const asked = ((await CategoryRequestModel.findOne({ key: 'eyedrop' }).lean())?.shops ?? []).map((x) => x.shopId);
  check('both asking shops are told', asked.length === 2 && (await NotificationModel.countDocuments({ shopId: { $in: asked }, type: 'CATEGORY_DECIDED' })) === 2);
  check('admin audit names Root and the email link', Boolean(await AdminAuditModel.exists({ adminName: 'Root', action: 'category_approve', text: /email link/ })));
  check('the same link again → 404 (used once)', (await link.post(`/public/category-requests/${rootLink}`, { decision: 'reject' })).status === 404);
  const after = data<Page>(await link.get(`/public/category-requests/${ashaLink}`));
  check('the other admin’s link now says approved by Root', after.status === 'approved' && after.decidedBy === 'Root');
  check('…and can’t decide again', (await link.post(`/public/category-requests/${ashaLink}`, { decision: 'reject' })).status === 404);
  check('asking for it now just adds it', (await a.post('/categories', { name: 'Eye drops' })).status === 409);

  section('5. Console: list, reject with a reason, roles');
  await a.post('/categories', { name: 'Hair oil' });
  const root = await login('root@cat.test');
  const help = await login('help@cat.test');
  const list = data<{ id: string; name: string; status: string }[]>(await root.get('/admin/category-requests'));
  const hair = list.find((r) => r.name === 'Hair oil');
  check('console lists both asks', list.length === 2 && hair?.status === 'pending');
  check('support can see, can’t decide → 403', (await help.get('/admin/category-requests')).status === 200 && (await help.post(`/admin/category-requests/${hair?.id ?? ''}`, { decision: 'approve' })).status === 403);
  const no = await root.post(`/admin/category-requests/${hair?.id ?? ''}`, { decision: 'reject', reason: 'Use Personal care' });
  check('super rejects with a reason → 200', no.status === 200, code(no));
  check('deciding twice → 409', (await root.post(`/admin/category-requests/${hair?.id ?? ''}`, { decision: 'approve' })).status === 409);
  check('nobody got Hair oil', !data<Cat[]>(await a.get('/categories')).some((x) => x.name === 'Hair oil'));
  check('the shop sees it turned down, with the reason', data<Ask[]>(await a.get('/categories/requests')).some((r) => r.name === 'Hair oil' && r.status === 'rejected' && r.reason === 'Use Personal care'));
  const re = await b.post('/categories', { name: 'hair oils' });
  check('asking again for a turned-down one → 409 with the reason', re.status === 409 && (re.json.error?.message ?? '').includes('Use Personal care'), code(re));
  const hairMail = await EmailJobModel.findOne({ kind: 'category_request', text: /Hair oil/ }).lean();
  const hairLink = /category-request\/([A-Za-z0-9_-]{32})/.exec(hairMail?.text ?? '')?.[1] ?? '';
  check('its email link now shows rejected', data<Page>(await link.get(`/public/category-requests/${hairLink}`)).status === 'rejected');

  section('6. An old link');
  await a.post('/categories', { name: 'Pet care' });
  const petMail = await EmailJobModel.findOne({ kind: 'category_request', text: /Pet care/, to: 'root@cat.test' }).lean();
  const petLink = /category-request\/([A-Za-z0-9_-]{32})/.exec(petMail?.text ?? '')?.[1] ?? '';
  await CategoryRequestModel.updateOne({ key: 'petcare' }, { $set: { linksExpire: new Date(Date.now() - 1000) } });
  check('after 7 days the page says expired', data<Page>(await link.get(`/public/category-requests/${petLink}`)).expired);
  check('…and the link can’t decide → 409', (await link.post(`/public/category-requests/${petLink}`, { decision: 'approve' })).status === 409);
  check('the console still can', (await root.post(`/admin/category-requests/${String((await CategoryRequestModel.findOne({ key: 'petcare' }).lean())?._id)}`, { decision: 'approve' })).status === 200);
  await a.post('/categories', { name: 'Ortho support' });
  const orthoAsha = /category-request\/([A-Za-z0-9_-]{32})/.exec((await EmailJobModel.findOne({ kind: 'category_request', text: /Ortho support/, to: 'asha@cat.test' }).lean())?.text ?? '')?.[1] ?? '';
  await AdminUserModel.updateOne({ email: 'asha@cat.test' }, { $set: { status: 'disabled' } });
  check('an admin disabled after the email can’t use the link → 403', (await link.post(`/public/category-requests/${orthoAsha}`, { decision: 'approve' })).status === 403);
  await a.post('/categories', { name: 'Gloves box' });
  check('a disabled admin gets no new email', (await EmailJobModel.countDocuments({ kind: 'category_request', text: /Gloves box/ })) === 1);

  await h.close();
  finish();
}

main().catch(crash);
