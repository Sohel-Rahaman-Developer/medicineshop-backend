import { mkdirSync, rmSync } from 'node:fs';
import { crc32 as zlibCrc32 } from 'node:zlib';
import type { Server } from 'node:http';

export const SHOP_ORIGIN = 'http://localhost:3000';
export const ADMIN_ORIGIN = 'http://localhost:3001';

let pass = 0;
let fail = 0;
export const out = (s: string) => process.stdout.write(s);

export function check(label: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass++;
    out(`  ✅ ${label}\n`);
  } else {
    fail++;
    out(`  ❌ ${label} ${extra}\n`);
  }
}

export function section(title: string): void {
  out(`\n${title}\n`);
}

export interface Res {
  status: number;
  headers: Headers;
  setCookies: string[];
  json: {
    success?: boolean;
    data?: unknown;
    message?: string;
    error?: { code: string; message?: string; details?: unknown };
  };
  text: string;
  body: Buffer;
}

interface StoredCookie {
  value: string;
  path: string;
}

/** Minimal cookie jar: host-only cookies, Path matching, deletion by Max-Age=0 / Expires in the past. */
class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  store(setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair = '', ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let path = '/';
      let expired = value === '';
      for (const attr of attrs) {
        const [k = '', v = ''] = attr.split('=');
        const key = k.toLowerCase();
        if (key === 'path') path = v;
        if (key === 'max-age' && Number(v) <= 0) expired = true;
        if (key === 'expires' && new Date(v).getTime() <= Date.now()) expired = true;
      }
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, { value, path });
    }
  }

  headerFor(pathname: string): string {
    return [...this.cookies.entries()]
      .filter(([, c]) => pathname === c.path || pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
      .map(([n, c]) => `${n}=${c.value}`)
      .join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)?.value;
  }

  set(name: string, value: string, path: string): void {
    this.cookies.set(name, { value, path });
  }

  clear(): void {
    this.cookies.clear();
  }
}

export interface ClientOptions {
  origin?: string | null;
  /** Fetch and send the CSRF token automatically (default true). */
  csrf?: boolean;
}

export class Client {
  readonly jar = new CookieJar();
  private csrfToken: string | undefined;
  /** Sent as X-Shop-Id when set. */
  shopId: string | undefined;

  constructor(
    private readonly base: string,
    private readonly opts: ClientOptions = {},
  ) {}

  private get origin(): string | null {
    return this.opts.origin === undefined ? SHOP_ORIGIN : this.opts.origin;
  }

  async loadCsrf(): Promise<string> {
    const res = await this.raw('GET', '/auth/csrf');
    const token = (res.json.data as { csrfToken?: string } | undefined)?.csrfToken ?? '';
    this.csrfToken = token;
    return token;
  }

  setCsrf(token: string | undefined): void {
    this.csrfToken = token;
  }

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const url = new URL(this.base + path);
    const cookie = this.jar.headerFor(url.pathname);
    const res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...(this.origin && method !== 'GET' ? { origin: this.origin } : {}),
        ...(this.shopId ? { 'x-shop-id': this.shopId } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const setCookies = res.headers.getSetCookie();
    this.jar.store(setCookies);
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let json: Res['json'] = {};
    try {
      json = JSON.parse(text) as Res['json'];
    } catch {
      // Non-JSON body — tests read `text` instead.
    }
    return { status: res.status, headers: res.headers, setCookies, json, text, body: bytes };
  }

  async send(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown = {}): Promise<Res> {
    if (this.opts.csrf !== false && this.csrfToken === undefined) await this.loadCsrf();
    const headers: Record<string, string> = this.csrfToken ? { 'x-csrf-token': this.csrfToken } : {};
    return this.raw(method, path, body, headers);
  }

  post(path: string, body: unknown = {}): Promise<Res> {
    return this.send('POST', path, body);
  }

  put(path: string, body: unknown = {}): Promise<Res> {
    return this.send('PUT', path, body);
  }

  patch(path: string, body: unknown = {}): Promise<Res> {
    return this.send('PATCH', path, body);
  }

  del(path: string, body: unknown = {}): Promise<Res> {
    return this.send('DELETE', path, body);
  }

  get(path: string): Promise<Res> {
    return this.raw('GET', path);
  }
}

export interface Harness {
  base: string;
  signIn: (email: string) => Promise<Client>;
  close: () => Promise<void>;
  seedOtp: (email: string, code: string, audience?: 'shop' | 'admin') => Promise<void>;
  client: (opts?: ClientOptions) => Client;
}

/** Must run before anything imports src/config/env — env is read once at import. */
/** `dbPath`: a fixed folder, wiped first — for servers that get killed before they can clean up (e2e on Windows). */
export async function startHarness(opts: { port?: number; dbPath?: string } = {}): Promise<Harness> {
  process.env.MONGOMS_LAUNCH_TIMEOUT ??= '120000';
  out('\n⏳ Starting in-memory MongoDB…\n');
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  if (opts.dbPath) {
    rmSync(opts.dbPath, { recursive: true, force: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test server names its own temp folder
    mkdirSync(opts.dbPath, { recursive: true });
  }
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 }, ...(opts.dbPath ? { instanceOpts: [{ dbPath: opts.dbPath }] } : {}) });

  Object.assign(process.env, {
    MONGODB_URI: rs.getUri('medicineshop_smoke'),
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    SHOP_APP_URL: SHOP_ORIGIN,
    ADMIN_APP_URL: ADMIN_ORIGIN,
    JWT_ACCESS_SECRET: 'smoke-test-access-secret-0123456789abcdef',
    CSRF_SECRET: 'smoke-test-csrf-secret-0123456789abcdefgh', // gitleaks:allow
    COOKIE_SECURE: 'false',
    SMTP_HOST: '',
    DEV_STATIC_OTP: '',
    // Local orders and real HMAC signatures with these test secrets (B8).
    PAYMENTS_MODE: 'test',
    RAZORPAY_KEY_ID: 'rzp_test_local',
    RAZORPAY_KEY_SECRET: 'smoke-razorpay-key-secret',
    RAZORPAY_WEBHOOK_SECRET: 'smoke-razorpay-webhook-secret',
    BILLING_LEGAL_NAME: 'MedBox24 Technologies Pvt Ltd',
    BILLING_ADDRESS: '5 Camac Street, Kolkata 700017',
    BILLING_STATE: 'West Bengal',
    BILLING_GSTIN: '19AABCM1234A1Z5',
  });

  const { connectDb, disconnectDb } = await import('../../src/config/db.js');
  const { createApp } = await import('../../src/app.js');
  const { OtpTokenModel } = await import('../../src/modules/auth/models/otp-token.model.js');
  const { hashOtp } = await import('../../src/utils/crypto.js');

  await connectDb();
  const server: Server = createApp().listen(opts.port ?? 0);
  await new Promise<void>((resolve) => server.once('listening', () => { resolve(); }));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}/api/v1`;

  const seed = async (email: string, code: string, audience: 'shop' | 'admin' = 'shop') => {
    await OtpTokenModel.updateMany({ audience, email, consumedAt: null }, { $set: { consumedAt: new Date() } });
    await OtpTokenModel.create({ audience, email, otpHash: await hashOtp(code), maxAttempts: 5, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
  };

  return {
    base,
    client: (opts) => new Client(base, opts),
    signIn: async (email) => {
      const c = new Client(base);
      await seed(email, '424242');
      const res = await c.post('/auth/otp/verify', { email, otp: '424242' });
      if (res.status !== 200) throw new Error(`sign-in failed for ${email}: ${res.status} ${res.text}`);
      return c;
    },
    seedOtp: seed,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
      await disconnectDb();
      await rs.stop();
    },
  };
}

export function finish(): never {
  out(`\n${'─'.repeat(46)}\n`);
  out(fail === 0 ? `✅ All ${pass} checks passed\n\n` : `❌ ${fail} failed, ${pass} passed\n\n`);
  process.exit(fail === 0 ? 0 : 1);
}

export function crash(err: unknown): never {
  out(`\n💥 ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
}

/** Reads a ZIP back through its central directory; every entry's CRC must match its bytes. */
export function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a ZIP');
  const files = new Map<string, Buffer>();
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (zlibCrc32(data) !== crc) throw new Error(`CRC mismatch: ${name}`);
    files.set(name, data);
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}
