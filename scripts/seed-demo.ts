// Demo data in the dev database, made through the real API: shop, 5 staff, every kind of product, suppliers, purchase, bills, return.
// npm run seed:demo — once; npm run seed:demo -- --fresh drops the dev database first (local only).
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Client, SHOP_ORIGIN, type Res } from './lib/harness';

const SHOP = 'Shri Ram Medical Store';
const OWNER = 'owner@medshop.test';
const TEAM = [
  ['manager@medshop.test', 'Priya Das', 'manager'],
  ['cashier@medshop.test', 'Sunita Roy', 'cashier'],
  ['stock@medshop.test', 'Ravi Kumar', 'stockKeeper'],
  ['accounts@medshop.test', 'Meera Jain', 'accountant'],
] as const;
// Column order of the Excel template (products.import.ts TEMPLATE_COLUMNS).
const KEYS = ['name', 'company', 'salt', 'strength', 'category', 'schedule', 'gst', 'hsn', 'barcode', 'saleUnit', 'baseUnit', 'pack', 'purchaseUnit', 'purchasePack', 'storage', 'hasExpiry', 'batch', 'expiry', 'quantity', 'mrp', 'rate', 'minPrice', 'rack'] as const;

const fail = (what: string, r: Res) => new Error(`${what}: ${String(r.status)} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? r.text.slice(0, 300)}`);
async function ok<T>(what: string, p: Promise<Res>): Promise<T> {
  const r = await p;
  if (r.status !== 200 && r.status !== 201) throw fail(what, r);
  return r.json.data as T;
}

async function main() {
  process.env.LOG_LEVEL = 'error';
  const { env } = await import('../src/config/env.js');
  const host = new URL(env.MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).hostname;
  if (env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(host)) throw new Error('seed:demo runs only on a local development database');

  const mongoose = (await import('mongoose')).default;
  const { connectDb, disconnectDb } = await import('../src/config/db.js');
  const { createApp } = await import('../src/app.js');
  const { OtpTokenModel } = await import('../src/modules/auth/models/otp-token.model.js');
  const { hashOtp } = await import('../src/utils/crypto.js');
  const { ShopModel } = await import('../src/modules/shops/shop.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { TEMPLATE_ROWS } = await import('../src/modules/products/products.import.js');

  await connectDb();
  if (process.argv.includes('--fresh')) {
    await mongoose.connection.dropDatabase();
    process.stdout.write(`Dropped ${mongoose.connection.name}\n`);
    await disconnectDb();
    await connectDb();
  }
  if (await ShopModel.exists({ name: SHOP })) {
    process.stdout.write(`“${SHOP}” is already there — nothing to do. Use npm run seed:demo -- --fresh to start over.\n`);
    await disconnectDb();
    return;
  }

  const server: Server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => { resolve(); }));
  const addr = server.address();
  const base = `http://127.0.0.1:${String(typeof addr === 'object' && addr ? addr.port : 0)}/api/v1`;
  const signIn = async (email: string) => {
    const code = String(Math.floor(100_000 + Math.random() * 900_000));
    await OtpTokenModel.updateMany({ email, consumedAt: null }, { $set: { consumedAt: new Date() } });
    await OtpTokenModel.create({ audience: 'shop', email, otpHash: await hashOtp(code), maxAttempts: 5, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    const c = new Client(base, { origin: SHOP_ORIGIN });
    await ok('sign in', c.post('/auth/otp/verify', { email, otp: code }));
    return c;
  };

  try {
    const owner = await signIn(OWNER);
    const shopId = (
      await ok<{ id: string }>(
        'shop',
        owner.post('/shops', {
          owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
          shop: { name: SHOP, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
          termsVersion: '2026-10',
          agree: true,
        }),
      )
    ).id;
    owner.shopId = shopId;
    await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 10 } });
    process.stdout.write(`Shop ${SHOP}\n`);

    const rows = TEMPLATE_ROWS.map((r) => Object.fromEntries(KEYS.map((k, i) => [k, r[i] ?? ''])));
    const imp = await ok<{ result: { newProducts: number; stockRows: number } }>('import', owner.post('/products/import', { clientRequestId: randomUUID(), dryRun: false, rows }));
    process.stdout.write(`Products: ${String(imp.result.newProducts)} from ${String(rows.length)} rows (${String(imp.result.stockRows)} with stock)\n`);
    const products = await ok<{ id: string; name: string }[]>('products', owner.get('/products?limit=100'));
    const pid = (name: string) => {
      const p = products.find((x) => x.name.startsWith(name));
      if (!p) throw new Error(`no product ${name}`);
      return p.id;
    };

    const sup = (body: Record<string, unknown>) => ok<{ id: string }>('supplier', owner.post('/suppliers', { contactPerson: '', email: '', gstin: '', drugLicense: '', address: 'Bagri Market, Kolkata', ...body }));
    const sharma = (await sup({ name: 'Sharma Distributors', contactPerson: 'Anil Sharma', phone: '98311 22334', gstin: '19ABCDE1234F1Z5', drugLicense: 'WB/KOL/20B/1189', creditDays: 30 })).id;
    await sup({ name: 'Gupta Pharma', phone: '98311 99887', creditDays: 15 });
    const day = (n: number) => new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
    const line = (o: Record<string, unknown>) => ({ freeQuantity: 0, unit: 'STRIP', discountPercent: 0, gstRate: 12, rack: '', ...o });
    await ok(
      'purchase',
      owner.post('/purchases', {
        clientRequestId: randomUUID(),
        supplierId: sharma,
        invoiceNumber: 'SD/26/1189',
        invoiceDate: day(-3),
        lines: [line({ productId: pid('Dolo 650'), batchNumber: 'DL2601', expiry: '2028-06', quantity: 50, freeQuantity: 5, rate: 2340, mrp: 3350 }), line({ productId: pid('Pan 40'), batchNumber: 'PN6012', expiry: '2027-11', quantity: 20, rate: 11_800, mrp: 15_540 })],
        payment: { mode: 'UPI', amount: 100_000, reference: 'UTR4471' },
      }),
    );
    process.stdout.write('Suppliers: 2 · purchase SD/26/1189 (part paid)\n');

    const roles = await ok<{ id: string; key: string | null }[]>('roles', owner.get('/roles'));
    const team = new Map<string, Client>();
    for (const [email, name, key] of TEAM) {
      await ok(`invite ${key}`, owner.post('/staff', { email, name, roleId: roles.find((r) => r.key === key)?.id }));
      const c = await signIn(email);
      const inv = (await ok<{ id: string }[]>('invitations', c.get('/invitations')))[0]?.id ?? '';
      await ok('accept', c.post(`/invitations/${inv}/accept`, { name }));
      c.shopId = shopId;
      team.set(key, c);
    }
    process.stdout.write(`Staff: ${String(TEAM.length)} invited and joined\n`);

    // The server prices a bill; an expectedTotal of 0 makes it say the total (409) before anything is saved.
    const sell = async (c: Client, items: Record<string, unknown>[], extra: Record<string, unknown> = {}, mode = 'CASH') => {
      const quote = await c.post('/sales', { clientRequestId: randomUUID(), items, payments: [], expectedTotal: 0, ...extra });
      const total = (quote.json.error as { details?: { total?: number } } | undefined)?.details?.total ?? 0;
      return ok<{ id: string; billNumber: string }>('bill', c.post('/sales', { clientRequestId: randomUUID(), items, payments: total ? [{ mode, amount: total, reference: mode === 'UPI' ? 'UPI8812' : '' }] : [], ...extra }));
    };
    const cashier = team.get('cashier') ?? owner;
    const b1 = await sell(owner, [{ productId: pid('Dolo 650'), quantity: 2, unit: 'STRIP' }, { productId: pid('Mox 500'), quantity: 1, unit: 'STRIP' }], { customer: { name: 'Ratna Sen', phone: '98300 12345' } });
    await sell(owner, [{ productId: pid('Alprax'), quantity: 1, unit: 'STRIP' }], { rx: { doctorName: 'Dr. S. Banerjee', patientName: 'Amit Das', rxNumber: 'RX-88' } });
    await sell(owner, [{ productId: pid('Benadryl'), quantity: 1, unit: 'BOTTLE' }, { productId: pid('Cadbury'), quantity: 2, unit: 'BAR' }], {}, 'UPI');
    await sell(owner, [{ productId: pid('Omron'), quantity: 1, unit: 'PIECE', price: 230_000 }]);
    await sell(owner, [{ productId: pid('Betadine'), quantity: 1, unit: 'TUBE' }], { billDiscount: { type: 'pct', value: 25 } });
    await sell(cashier, [{ productId: pid('Coca-Cola'), quantity: 3, unit: 'CAN' }, { productId: pid('Dolo 650'), quantity: 5, unit: 'TABLET' }]);
    await sell(cashier, [{ productId: pid("Johnson's"), quantity: 1, unit: 'BOTTLE' }], { customer: { name: 'Kakoli Ghosh', phone: '98310 55667' } }, 'UPI');
    const gone = await sell(owner, [{ productId: pid('Surgical Gloves'), quantity: 4, unit: 'PAIR' }]);
    await ok('cancel', owner.post(`/sales/${gone.id}/cancel`, { reason: 'Customer changed mind' }));
    await ok('return', owner.post('/sale-returns', { clientRequestId: randomUUID(), saleId: b1.id, items: [{ line: 0, quantity: 7, reason: 'Bought extra by mistake' }], refundMode: 'CREDIT_NOTE' }));
    process.stdout.write('Bills: 8 (H1, UPI, typed price, 25 % discount, cashier, 1 cancelled) · 1 return with a credit note\n');

    const pad = (s: string) => s.padEnd(24);
    process.stdout.write(
      `\nSign in at ${env.SHOP_APP_URL}/login with any of these (no password — a 6-digit code):\n` +
        `  ${pad(OWNER)}Owner\n` +
        TEAM.map(([email, , key]) => `  ${pad(email)}${key}\n`).join('') +
        (env.DEV_STATIC_OTP ? `The code is ${env.DEV_STATIC_OTP} (DEV_STATIC_OTP in .env).\n` : 'Without SMTP in .env the code is printed in the backend terminal (npm run dev).\n'),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`💥 ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
