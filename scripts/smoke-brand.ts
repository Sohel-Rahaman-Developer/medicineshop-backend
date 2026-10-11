// The platform logo: only a super admin uploads it, with a reason; every icon is made from it; reset brings back the built-in one.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;

async function main() {
  const h = await startHarness();
  const sharp = (await import('sharp')).default;
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { invoicePdf } = await import('../src/core/invoice-pdf.js');
  const step = () => Math.floor(Date.now() / 30_000);

  await AdminUserModel.create({ email: 'root@brand.test', name: 'Root', role: 'super' });
  await AdminUserModel.create({ email: 'help@brand.test', name: 'Sara', role: 'support' });
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const s = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' })).secret ?? '';
    await c.post('/admin/auth/totp', { code: totpAt(s, step()) });
    return c;
  };
  const root = await login('root@brand.test');
  const helper = await login('help@brand.test');
  const pub = h.client({ origin: null, csrf: false });

  const dataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;
  // A teal disc on transparent, the kind of logo people upload.
  const disc = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><circle cx="300" cy="300" r="260" fill="#0fb5a8"/><rect x="250" y="140" width="100" height="320" fill="#fff"/><rect x="140" y="250" width="320" height="100" fill="#fff"/></svg>')).png().toBuffer();
  const opaque = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#2a6cf5' } }).jpeg().toBuffer();
  const small = await sharp({ create: { width: 120, height: 120, channels: 4, background: '#2a6cf5' } }).png().toBuffer();
  const wide = await sharp({ create: { width: 900, height: 400, channels: 4, background: '#2a6cf5' } }).png().toBuffer();
  const sizeOf = async (b: Buffer) => { const m = await sharp(b).metadata(); return `${String(m.width)}×${String(m.height)}`; };
  const images = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;
  const spec = { size: 'A4' as const, title: 'TAX INVOICE', meta: [['Invoice no.', 'MBX-1']] as [string, string][], issuer: { name: 'MedBox24', lines: [] }, logo: true, parties: [], columns: [{ label: 'Item', w: 1 }], rows: [], totals: [], notes: [], footer: '' };

  section('1. The built-in logo until someone uploads one');
  const info0 = data<{ custom: boolean; version: number }>(await pub.get('/brand'));
  check('public /brand: built-in, version 0', !info0.custom && info0.version === 0, JSON.stringify(info0));
  check('a logo file is 404 while the built-in one is in use', (await pub.raw('GET', '/brand/mark.png')).status === 404);
  check('an unknown file name → 422', (await pub.raw('GET', '/brand/secret.txt')).status === 422);
  check('MedBox24’s invoice draws its own mark (no image inside)', images(await invoicePdf(spec)) === 0);

  section('2. Only a super admin, only with a reason, only a real square image');
  check('support role → 403', (await helper.put('/admin/brand', { image: dataUrl('image/png', disc), reason: 'New brand from marketing' })).status === 403);
  check('no reason → 422', (await root.put('/admin/brand', { image: dataUrl('image/png', disc) })).status === 422);
  const fake = await root.put('/admin/brand', { image: dataUrl('image/png', Buffer.from('<svg onload=alert(1)>')), reason: 'Testing a fake file' });
  check('text dressed as a PNG → 422', fake.status === 422 && /not the image/.test(code(fake)), code(fake));
  const svg = await root.put('/admin/brand', { image: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`, reason: 'Testing an SVG file' });
  check('SVG (could carry script) → 422', svg.status === 422, code(svg));
  const tiny = await root.put('/admin/brand', { image: dataUrl('image/png', small), reason: 'Testing a small logo' });
  check('120 px → 422, says the size', tiny.status === 422 && /120 × 120/.test(code(tiny)), code(tiny));
  const banner = await root.put('/admin/brand', { image: dataUrl('image/png', wide), reason: 'Testing a wide logo' });
  check('900 × 400 (name beside the mark) → 422, asks for a square', banner.status === 422 && /square/.test(code(banner)), code(banner));
  check('nothing was saved by the refusals', !data<{ custom: boolean }>(await pub.get('/brand')).custom);

  section('3. Upload: every icon is made from it, in its size');
  const up = await root.put('/admin/brand', { image: dataUrl('image/png', disc), reason: 'New brand from marketing' });
  check('saved, version 1', up.status === 200 && data<{ custom: boolean; version: number }>(up).version === 1, code(up));
  check('admin audit: who and why', Boolean(await AdminAuditModel.exists({ action: 'brand_logo', adminName: 'Root', reason: 'New brand from marketing' })));
  const want: [string, string, string][] = [['mark.png', 'image/png', '512×512'], ['mark-white.png', 'image/png', '512×512'], ['icon-192.png', 'image/png', '192×192'], ['icon-512.png', 'image/png', '512×512'], ['maskable-512.png', 'image/png', '512×512'], ['apple.png', 'image/png', '180×180'], ['admin-apple.png', 'image/png', '180×180'], ['og.png', 'image/png', '1200×630']];
  for (const [file, type, size] of want) {
    const r = await pub.raw('GET', `/brand/${file}`);
    check(`${file}: ${size}, ${type}, cached 5 min`, r.status === 200 && r.headers.get('content-type') === type && (await sizeOf(r.body)) === size && r.headers.get('cache-control') === 'public, max-age=300', `${String(r.status)} ${r.headers.get('content-type') ?? ''} ${r.headers.get('cache-control') ?? ''}`);
  }
  for (const file of ['favicon.ico', 'admin-favicon.ico']) {
    const r = await pub.raw('GET', `/brand/${file}`);
    check(`${file}: an .ico with 16, 32 and 48 px`, r.status === 200 && r.headers.get('content-type') === 'image/x-icon' && r.body.readUInt16LE(2) === 1 && r.body.readUInt16LE(4) === 3 && [0, 1, 2].map((i) => r.body[6 + 16 * i]).join() === '16,32,48');
  }
  const mark = (await pub.raw('GET', '/brand/mark.png')).body;
  const corner = await sharp(mark).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  check('the logo keeps its transparent background', corner[3] === 0);
  const tile = await sharp((await pub.raw('GET', '/brand/admin-apple.png')).body).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer();
  check('the admin icon sits on the navy tile', tile[0] === 0x05 && tile[1] === 0x22 && tile[2] === 0x42, [...tile].join());
  const white = await sharp((await pub.raw('GET', '/brand/mark-white.png')).body).extract({ left: 300, top: 150, width: 1, height: 1 }).raw().toBuffer();
  check('the white mark is white where the logo is', white[0] === 255 && white[1] === 255 && white[2] === 255 && (white[3] ?? 0) > 200, [...white].join());
  // A PNG with transparency is two image objects in a PDF: the picture and its alpha mask.
  check('MedBox24’s invoice now carries the uploaded logo', images(await invoicePdf(spec)) === 2);

  section('4. A logo without transparency, then back to the built-in one');
  const jpg = await root.put('/admin/brand', { image: dataUrl('image/jpeg', opaque), reason: 'Try the square version' });
  check('a JPEG is fine too → version 2', jpg.status === 200 && data<{ version: number }>(jpg).version === 2, code(jpg));
  const onWhite = (await pub.raw('GET', '/brand/mark-white.png')).body;
  const px = async (x: number, y: number) => [...(await sharp(onWhite).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
  const [cornerPx, edgePx, middlePx] = [await px(0, 0), await px(10, 256), await px(256, 256)];
  check('no transparency: the white mark is the logo on a rounded white tile, not a white square', cornerPx[3] === 0 && edgePx.join() === '255,255,255,255' && [42, 108, 245].every((c, i) => Math.abs((middlePx[i] ?? 0) - c) <= 3), `${cornerPx.join()} | ${edgePx.join()} | ${middlePx.join()}`);
  check('support role cannot reset → 403', (await helper.del('/admin/brand', { reason: 'Back to the old logo' })).status === 403);
  const reset = await root.del('/admin/brand', { reason: 'Back to the old logo' });
  check('reset → built-in, version 3 (a new version, so no cached copy shows the old file)', reset.status === 200 && !data<{ custom: boolean }>(reset).custom && data<{ version: number }>(reset).version === 3, code(reset));
  check('files are 404 again', (await pub.raw('GET', '/brand/og.png')).status === 404);
  check('reset is audited', Boolean(await AdminAuditModel.exists({ action: 'brand_reset', reason: 'Back to the old logo' })));
  check('reset twice → 400', (await root.del('/admin/brand', { reason: 'Back to the old logo' })).status === 400);
  check('the invoice draws the built-in mark again', images(await invoicePdf(spec)) === 0);
  const meAdmin = data<{ custom: boolean; updatedBy: string }>(await helper.get('/admin/brand'));
  check('any admin can see which logo is in use and who changed it', !meAdmin.custom && meAdmin.updatedBy === 'Root');

  await h.close();
  finish();
}

main().catch(crash);
