// D92 / D93 checks: a customer's secret points link (made once, renewed kills the old), the public points page (first
// name only, no phone), the shop's counter QR page, the shop logo on the app, its public URL and the bill PDF.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
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
  enabled: true, earnRate: 1, earnPerAmount: 10_000, minBillForEarning: 0, excludedCategories: [] as string[], earnOnDiscountedAmount: true, pointValue: 100,
  minPointsToRedeem: 100, maxRedeemPercent: 20, redeemMultipleOf: 10, pointExpiryMonths: 12, expiryWarningDays: 30,
  tiers: [{ name: 'Silver', minLifetimePoints: 0, earnMultiplier: 1 }, { name: 'Gold', minLifetimePoints: 1000, earnMultiplier: 1.25 }],
  birthdayBonusPoints: 100,
};
const png = async (w: number, h: number) => `data:image/png;base64,${(await sharp({ create: { width: w, height: h, channels: 4, background: { r: 15, g: 181, b: 168, alpha: 1 } } }).png().toBuffer()).toString('base64')}`;

interface Points { shop: { name: string; city: string; logo: string | null }; on: boolean; name: string; points: number; value: number; tier: string; lastBill: { number: string; earned: number } | null; history: { type: string; label: string; points: number; bill: string | null }[]; rules: { pointValue: number } | null }
interface ShopPage { shop: { name: string; logo: string | null }; loyalty: { earnPerAmount: number; tiers: unknown[] } | null }

async function main() {
  const h = await startHarness();
  const { CustomerModel } = await import('../src/modules/customers/customer.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');

  const owner = await h.signIn('rohit@points1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const dolo = data<{ id: string }>(await owner.post('/products', { name: 'Dolo 650 Tablet', company: 'Micro Labs', salt: 'Paracetamol', strength: '', categoryId: cats.find((c) => c.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL1', expiry: '2028-12', quantity: 1500, mrp: 3000, purchaseRate: 1950 });
  const ratna = data<{ id: string }>(await owner.post('/customers', { name: 'Ratna Sen Gupta', phone: '98300 12345' })).id;
  const pub = h.client({ origin: null });

  section('1. Points off → no link');
  const off = await owner.get(`/customers/${ratna}/points-link`);
  check('loyalty off → no link, none made', off.status === 200 && data<{ url: string | null }>(off).url === null && !(await CustomerModel.findOne({ shopId: shop1, _id: ratna }).lean())?.pointsToken, code(off));

  section('2. The customer’s own link');
  await owner.patch('/loyalty/settings', RULES);
  const bill = data<{ id: string; billNumber: string; pointsEarned: number }>(await owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: 10, unit: 'STRIP' }], customerId: ratna, payments: [{ mode: 'CASH', amount: 30_000 }] }));
  const l1 = data<{ url: string }>(await owner.get(`/customers/${ratna}/points-link`));
  const token = l1.url.split('/p/')[1] ?? '';
  check('a link on the shop app’s address, with a 24-character secret', l1.url.startsWith('http://localhost:3000/p/') && /^[A-Za-z0-9_-]{24}$/.test(token), l1.url);
  check('asking again gives the same link', data<{ url: string }>(await owner.get(`/customers/${ratna}/points-link`)).url === l1.url);
  check('the customer’s own record never shows the secret', !JSON.stringify((await owner.get(`/customers/${ratna}`)).json).includes(token));

  section('3. The page behind the link — no sign-in');
  const p = await pub.get(`/public/points/${token}`);
  const pts = data<Points>(p);
  check('opens without signing in', p.status === 200, code(p));
  check('first name only — no surname, no phone', pts.name === 'Ratna' && !JSON.stringify(p.json).includes('Gupta') && !JSON.stringify(p.json).includes('98300'), JSON.stringify(pts));
  check('points, their ₹ value and the tier', pts.on && pts.points === 3 && pts.value === 300 && pts.tier === 'Silver', JSON.stringify(pts));
  check('the last bill and what it earned', pts.lastBill?.number === bill.billNumber && pts.lastBill.earned === 3);
  check('history: “Earned” on that bill', pts.history[0]?.label === 'Earned' && pts.history[0].bill === bill.billNumber && pts.history[0].points === 3);
  check('the shop’s name and city; no logo yet', pts.shop.name === 'Shri Ram Medical Store' && pts.shop.city === 'Kolkata' && pts.shop.logo === null);
  check('search engines are told to stay out', p.headers.get('x-robots-tag') === 'noindex');
  check('a made-up secret → 404', (await pub.get(`/public/points/${'A'.repeat(24)}`)).status === 404);
  check('not even shaped like a secret → 422', (await pub.get('/public/points/hello')).status === 422);

  section('4. A new link kills the old one');
  const renewed = await owner.post(`/customers/${ratna}/points-link`, {});
  const token2 = data<{ url: string }>(renewed).url.split('/p/')[1] ?? '';
  check('new link made', renewed.status === 200 && token2 !== token && token2.length === 24, code(renewed));
  check('the old link → 404', (await pub.get(`/public/points/${token}`)).status === 404);
  check('the new one opens', (await pub.get(`/public/points/${token2}`)).status === 200);
  check('the audit log says who made it', Boolean(await AuditLogModel.exists({ shopId: shop1, module: 'customers', text: { $regex: 'new points link' } })));

  section('5. The counter QR page');
  const counter = data<{ url: string; code: string }>(await owner.get('/loyalty/counter'));
  check('the counter QR points at /l/<code>', counter.url === `http://localhost:3000/l/${counter.code}` && /^[a-z2-9]{8}$/.test(counter.code), counter.url);
  const page1 = data<ShopPage>(await pub.get(`/public/shops/${counter.code}`));
  check('it shows the shop and how points work — no customer in it', page1.shop.name === 'Shri Ram Medical Store' && page1.loyalty?.earnPerAmount === 10_000 && page1.loyalty.tiers.length === 2 && !JSON.stringify(page1).includes('Ratna'));
  check('the same code every time', data<{ code: string }>(await owner.get('/loyalty/counter')).code === counter.code);
  check('an unknown code → 404', (await pub.get('/public/shops/abcdefgh')).status === 404);

  section('6. The shop’s logo');
  const ctx0 = data<{ logo: string | null }>(await owner.get('/shop/context'));
  check('no logo yet → the app shows MedBox24’s', ctx0.logo === null);
  check('without a logo the bill PDF has no image in it', !(await owner.get(`/sales/${bill.id}/pdf`)).text.includes('/Subtype /Image'));
  const wide = await owner.put('/shop/logo', { image: await png(600, 300) });
  check('a wide logo → 422', wide.status === 422, code(wide));
  const up = await owner.put('/shop/logo', { image: await png(400, 400) });
  const path = data<{ logo: string }>(up).logo;
  check('a square logo saved; its URL is the public one with a version', up.status === 200 && path === `/public/shops/${counter.code}/logo.png?v=1`, `${code(up)} ${path}`);
  check('the app’s context carries it', data<{ logo: string | null }>(await owner.get('/shop/context')).logo === path);
  const img = await pub.get(path);
  check('anyone can load it: a 512 px PNG, cached 5 minutes', img.status === 200 && img.headers.get('content-type') === 'image/png' && (img.headers.get('cache-control') ?? '').includes('max-age=300'), code(img));
  check('the points page and the QR page show it', data<Points>(await pub.get(`/public/points/${token2}`)).shop.logo === path && data<ShopPage>(await pub.get(`/public/shops/${counter.code}`)).shop.logo === path);
  const pdf = await owner.get(`/sales/${bill.id}/pdf`);
  check('the bill PDF carries the logo image', pdf.status === 200 && pdf.text.includes('/Subtype /Image'), code(pdf));
  check('a new logo bumps the version', data<{ logo: string }>(await owner.put('/shop/logo', { image: await png(512, 512) })).logo.endsWith('?v=2'));
  check('uploading is in the audit log', Boolean(await AuditLogModel.exists({ shopId: shop1, module: 'settings', text: 'Uploaded the shop logo' })));
  const gone = await owner.del('/shop/logo', {});
  check('removed → MedBox24’s again; its URL → 404', gone.status === 200 && data<{ logo: string | null }>(await owner.get('/shop/context')).logo === null && (await pub.get(path)).status === 404, code(gone));

  section('7. Another shop sees nothing of this one');
  const other = await h.signIn('mina@points2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Mina Medical'))).id;
  check('shop 2 can’t ask for shop 1’s customer link → 404', (await other.get(`/customers/${ratna}/points-link`)).status === 404);
  check('shop 2 can’t renew it → 404', (await other.post(`/customers/${ratna}/points-link`, {})).status === 404);

  section('8. A scraper is slowed down');
  let limited = false;
  for (let i = 0; i < 70 && !limited; i++) limited = (await pub.get(`/public/shops/${counter.code}`)).status === 429;
  check('more than 60 public requests a minute → 429', limited);

  await h.close();
  finish();
}

main().catch(crash);
