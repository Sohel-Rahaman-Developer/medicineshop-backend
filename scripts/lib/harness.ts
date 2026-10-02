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
    error?: { code: string; message?: string };
  };
  text: string;
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
    const text = await res.text();
    let json: Res['json'] = {};
    try {
      json = JSON.parse(text) as Res['json'];
    } catch {
      // Non-JSON body — tests read `text` instead.
    }
    return { status: res.status, headers: res.headers, setCookies, json, text };
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
  seedOtp: (email: string, code: string) => Promise<void>;
  client: (opts?: ClientOptions) => Client;
}

/** Must run before anything imports src/config/env — env is read once at import. */
export async function startHarness(opts: { port?: number } = {}): Promise<Harness> {
  process.env.MONGOMS_LAUNCH_TIMEOUT ??= '120000';
  out('\n⏳ Starting in-memory MongoDB…\n');
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

  Object.assign(process.env, {
    MONGODB_URI: rs.getUri('medicineshop_smoke'),
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    SHOP_APP_URL: SHOP_ORIGIN,
    ADMIN_APP_URL: ADMIN_ORIGIN,
    JWT_ACCESS_SECRET: 'smoke-test-access-secret-0123456789abcdef',
    CSRF_SECRET: 'smoke-test-csrf-secret-0123456789abcdefgh',
    COOKIE_SECURE: 'false',
    SMTP_HOST: '',
    DEV_STATIC_OTP: '',
    // Local orders and real HMAC signatures with these test secrets (B8).
    PAYMENTS_MODE: 'test',
    RAZORPAY_KEY_ID: 'rzp_test_local',
    RAZORPAY_KEY_SECRET: 'smoke-razorpay-key-secret',
    RAZORPAY_WEBHOOK_SECRET: 'smoke-razorpay-webhook-secret',
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

  const seed = async (email: string, code: string) => {
    await OtpTokenModel.updateMany({ email, consumedAt: null }, { $set: { consumedAt: new Date() } });
    await OtpTokenModel.create({ audience: 'shop', email, otpHash: await hashOtp(code), maxAttempts: 5, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
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
