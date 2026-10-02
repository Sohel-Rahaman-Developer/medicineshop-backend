import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what every authenticator app speaks. Secrets are stored AES-256-GCM encrypted.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31] ?? '';
  return out;
}

export function fromBase32(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32(randomBytes(20));

/** The 6-digit code for one 30-second step. */
export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const o = (h[h.length - 1] ?? 0) & 15;
  const code = (((h[o] ?? 0) & 127) << 24) | ((h[o + 1] ?? 0) << 16) | ((h[o + 2] ?? 0) << 8) | (h[o + 3] ?? 0);
  return String(code % 1_000_000).padStart(6, '0');
}

/** Accepts the current step and one either side (clock drift); returns the step used, so it can't be replayed. */
export function checkTotp(secret: string, code: string, now = Date.now()): number | null {
  const step = Math.floor(now / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    const a = Buffer.from(totpAt(secret, s));
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) return s;
  }
  return null;
}

export const otpauthUrl = (secret: string, email: string) => `otpauth://totp/MedShop%20Admin:${encodeURIComponent(email)}?secret=${secret}&issuer=MedShop%20Admin&algorithm=SHA1&digits=6&period=30`;

const keyOf = (key: string) => createHash('sha256').update(key).digest();

export function seal(plain: string, key: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(key), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function open(sealed: string, key: string): string {
  const [iv = '', tag = '', body = ''] = sealed.split('.');
  const d = createDecipheriv('aes-256-gcm', keyOf(key), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}
