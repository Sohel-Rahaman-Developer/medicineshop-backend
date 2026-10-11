import path from 'node:path';
import sharp from 'sharp';
import { AppError } from '../../core/errors';
import type { AdminActor } from '../admin/admin-auth';
import { log } from '../admin/admin.service';
import { SIGNATURES, bytesOf } from '../products/photo';
import { BrandModel } from './branding.model';

const MAX_INPUT_BYTES = 600 * 1024;
const MIN_SIDE = 256;
const MAX_INPUT_PIXELS = 4096 * 4096;
const NAVY = '#052242';
const OG_BASE = path.resolve(__dirname, '../../../assets/brand/og-base.png');
const TTL = 60_000;

/** Every file made from the uploaded logo: the shop app's icons, the admin's navy tab icons, the share card. */
export const BRAND_FILES = ['mark.png', 'mark-white.png', 'favicon.ico', 'icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png', 'apple.png', 'admin-favicon.ico', 'admin-apple.png', 'og.png'] as const;
export type BrandFile = (typeof BRAND_FILES)[number];

let cached: { at: number; version: number; mark: Buffer | null; hasAlpha: boolean; updatedBy: string | null; updatedAt: Date | null } | null = null;
const made = new Map<string, Buffer>();

/** The current logo (1-minute cache); mark null = the built-in one. */
export async function brand() {
  if (cached && Date.now() - cached.at < TTL) return cached;
  const d = await BrandModel.findById('brand').lean();
  cached = { at: Date.now(), version: d?.version ?? 0, mark: bytesOf(d?.mark), hasAlpha: d?.hasAlpha ?? true, updatedBy: d?.updatedBy ?? null, updatedAt: d?.updatedAt ?? null };
  return cached;
}

const forget = () => {
  cached = null;
  made.clear();
};

export async function brandInfo() {
  const b = await brand();
  return { custom: Boolean(b.mark), version: b.version, updatedBy: b.updatedBy, updatedAt: b.updatedAt };
}

const bad = (message: string) => AppError.validation(message, [{ field: 'body.image', message }]);

/** An uploaded logo → 1024 px square PNG on transparent; refuses what is not really an image, too small or far from square. */
export async function processLogo(dataUrl: string) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m?.[1] || !m[2]) throw bad('The logo must be a PNG, JPEG or WebP image');
  const input = Buffer.from(m[2], 'base64');
  if (input.length > MAX_INPUT_BYTES) throw bad('The logo file is larger than 600 KB');
  if (!SIGNATURES[m[1]]?.(input)) throw bad('That file is not the image it claims to be');
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
    const w = meta.width;
    const h = meta.height;
    if (Math.min(w, h) < MIN_SIDE) throw bad(`The logo is ${String(w)} × ${String(h)} px — use at least ${String(MIN_SIDE)} × ${String(MIN_SIDE)} (512 or more looks best)`);
    if (Math.max(w, h) / Math.min(w, h) > 1.25) throw bad(`The logo is ${String(w)} × ${String(h)} px — use a square logo (the mark only, without the name beside it)`);
    const mark = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().ensureAlpha().resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer();
    const { isOpaque } = await sharp(input).stats();
    return { mark, hasAlpha: !isOpaque };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw bad('That logo could not be read');
  }
}

const transparent = (size: number) => sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });

/** The logo at `scale` of a `size` square, on a tile of `bg` with rounded corners (`radius` of the side), or on nothing. */
async function onTile(mark: Buffer, size: number, scale: number, bg: string | null, radius = 0) {
  const inner = Math.round(size * scale);
  const logo = await sharp(mark).resize(inner, inner).png().toBuffer();
  const base = bg ? sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}"><rect width="${String(size)}" height="${String(size)}" rx="${String(Math.round(size * radius))}" fill="${bg}"/></svg>`)) : transparent(size);
  const at = Math.round((size - inner) / 2);
  return base.composite([{ input: logo, left: at, top: at }]).png({ compressionLevel: 9 }).toBuffer();
}

/** PNG images packed in one .ico (16, 32, 48). */
function ico(images: [number, Buffer][]) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(([size, png], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size, e);
    head.writeUInt8(size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map(([, png]) => png)]);
}

async function render(file: BrandFile, mark: Buffer, hasAlpha: boolean): Promise<Buffer> {
  switch (file) {
    case 'mark.png':
      return sharp(mark).resize(512, 512).png({ compressionLevel: 9 }).toBuffer();
    case 'mark-white.png': {
      // For coloured panels: a white silhouette when the logo has a transparent background, else the logo on a white tile.
      if (!hasAlpha) return onTile(mark, 512, 0.78, '#ffffff', 0.22);
      const alpha = await sharp(mark).resize(512, 512).extractChannel(3).png().toBuffer();
      return sharp({ create: { width: 512, height: 512, channels: 3, background: '#ffffff' } }).joinChannel(alpha).png({ compressionLevel: 9 }).toBuffer();
    }
    case 'favicon.ico':
      return ico(await Promise.all([16, 32, 48].map(async (n): Promise<[number, Buffer]> => [n, await sharp(mark).resize(n, n).png().toBuffer()])));
    case 'admin-favicon.ico':
      return ico(await Promise.all([16, 32, 48].map(async (n): Promise<[number, Buffer]> => [n, await onTile(mark, n, 0.8, NAVY, 0.22)])));
    case 'icon-192.png':
      return onTile(mark, 192, 0.8, '#ffffff', 0.22);
    case 'icon-512.png':
      return onTile(mark, 512, 0.8, '#ffffff', 0.22);
    case 'maskable-192.png':
      return onTile(mark, 192, 0.62, '#ffffff');
    case 'maskable-512.png':
      return onTile(mark, 512, 0.62, '#ffffff');
    case 'apple.png':
      return onTile(mark, 180, 0.82, '#ffffff');
    case 'admin-apple.png':
      return onTile(mark, 180, 0.82, NAVY);
    case 'og.png': {
      const logo = await sharp(mark).resize(300, 300).png().toBuffer();
      return sharp(OG_BASE).composite([{ input: logo, left: 90, top: 150 }]).png({ compressionLevel: 9 }).toBuffer();
    }
  }
}

/** One file made from the uploaded logo, or null while the built-in logo is in use. */
export async function brandFile(file: BrandFile) {
  const b = await brand();
  if (!b.mark) return null;
  const key = `${String(b.version)}:${file}`;
  const hit = made.get(key);
  if (hit) return hit;
  const out = await render(file, b.mark, b.hasAlpha);
  made.set(key, out);
  return out;
}

export async function saveLogo(a: AdminActor, dataUrl: string, reason: string, ip?: string) {
  const logo = await processLogo(dataUrl);
  const before = await BrandModel.findById('brand').lean();
  const version = (before?.version ?? 0) + 1;
  await BrandModel.updateOne({ _id: 'brand' }, { $set: { mark: logo.mark, hasAlpha: logo.hasAlpha, version, updatedBy: a.name } }, { upsert: true });
  forget();
  await log(a, 'brand_logo', reason, before?.mark ? 'replaced the platform logo' : 'uploaded a platform logo', undefined, { version }, ip);
  return brandInfo();
}

export async function resetLogo(a: AdminActor, reason: string, ip?: string) {
  const before = await BrandModel.findById('brand').lean();
  if (!before?.mark) throw AppError.badRequest('The built-in MedBox24 logo is already in use');
  const version = before.version + 1;
  await BrandModel.updateOne({ _id: 'brand' }, { $unset: { mark: 1 }, $set: { hasAlpha: true, version, updatedBy: a.name } });
  forget();
  await log(a, 'brand_reset', reason, 'went back to the built-in MedBox24 logo', undefined, { version }, ip);
  return brandInfo();
}
