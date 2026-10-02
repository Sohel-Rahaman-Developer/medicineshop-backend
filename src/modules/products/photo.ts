import sharp from 'sharp';
import { AppError } from '../../core/errors';

const OUT = 96;
const MAX_BYTES = 3 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_SIDE = 2048;

export const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

const bad = (message: string) => AppError.validation(message, [{ field: 'body.photo', message }]);

/**
 * Data URL from the browser crop → a fresh 96 × 96 WebP. Re-encoding drops EXIF / GPS and anything
 * hidden in the file; the declared type must match the real bytes (SECURITY §6 B2).
 */
export async function processPhoto(dataUrl: string): Promise<{ data: Buffer; bytes: number }> {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m?.[1] || !m[2]) throw bad('Photo must be a JPEG, PNG or WebP image');
  const input = Buffer.from(m[2], 'base64');
  if (input.length > MAX_INPUT_BYTES) throw bad('That photo is too large');
  if (!SIGNATURES[m[1]]?.(input)) throw bad('That file is not the image it claims to be');

  try {
    const img = sharp(input, { limitInputPixels: MAX_SIDE * MAX_SIDE, failOn: 'error' });
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width > MAX_SIDE || meta.height > MAX_SIDE) throw bad('That photo is too large');
    const square = img.rotate().resize(OUT, OUT, { fit: 'cover' }).flatten({ background: '#ffffff' });
    for (const quality of [80, 70, 60, 50, 40]) {
      const data = await square.clone().webp({ quality, effort: 4 }).toBuffer();
      if (data.length <= MAX_BYTES) return { data, bytes: data.length };
    }
    throw bad('This photo has too much detail to keep small. Crop closer to the pack.');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw bad('That photo could not be read');
  }
}

// Lean reads give a BSON Binary, hydrated docs a Buffer.
export const bytesOf = (d: unknown): Buffer | null =>
  Buffer.isBuffer(d) ? d : d && typeof d === 'object' && 'buffer' in d && d.buffer instanceof Uint8Array ? Buffer.from(d.buffer) : null;

export function photoUrl(p?: { data?: unknown } | null): string | null {
  const b = bytesOf(p?.data);
  return b ? `data:image/webp;base64,${b.toString('base64')}` : null;
}
