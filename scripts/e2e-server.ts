// API for the frontend Playwright suite: real app on :5000 + in-memory DB; a localhost-only helper on :5099 seeds OTPs.
import http from 'node:http';
import { crash, startHarness } from './lib/harness';

const API_PORT = Number(process.env.E2E_API_PORT ?? 5000);
const HELPER_PORT = Number(process.env.E2E_HELPER_PORT ?? 5099);

async function main() {
  process.env.PORT = String(API_PORT);
  // Every Playwright project signs in from the same IP; the per-email limits stay real.
  process.env.RATE_OTP_REQUEST_PER_IP ??= '1000';
  const h = await startHarness({ port: API_PORT });

  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  /** Admin suite (B9): make the address a super admin, seed its email code, and give it a shop to look at. */
  const seedAdmin = async (b: { email: string; code: string; shopName?: string }) => {
    await AdminUserModel.updateOne({ email: b.email }, { $setOnInsert: { email: b.email, name: 'E2E Root', role: 'super' } }, { upsert: true });
    await h.seedOtp(b.email, b.code, 'admin');
    if (b.shopName) {
      const owner = await h.signIn(`owner.${b.email}`);
      const r = await owner.post('/shops', { owner: { name: 'Shop Owner', phone: '98300 41122' }, shop: { name: b.shopName, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' }, termsVersion: '2026-10', agree: true });
      if (r.status !== 201) throw new Error(`shop: ${String(r.status)} ${r.text}`);
    }
  };

  const { ShopModel } = await import('../src/modules/shops/shop.model.js');
  const { SupportAccessModel } = await import('../src/modules/admin/support.js');
  const { emit } = await import('../src/modules/notifications/notifications.service.js');
  /** Shop suite: MedShop support asks to look at the named shop (as the admin console would). */
  const seedSupport = async (b: { shopName?: string }) => {
    const shop = await ShopModel.findOne({ name: b.shopName }).lean();
    if (!shop) throw new Error('shop not found');
    const admin = await AdminUserModel.findOneAndUpdate({ email: 'support@medshop.test' }, { $setOnInsert: { email: 'support@medshop.test', name: 'Sara (support)', role: 'support' } }, { upsert: true, returnDocument: 'after' });
    const d = await SupportAccessModel.create({ shopId: shop._id, adminUserId: admin._id, agentName: admin.name, reason: 'Owner asked about a bill total', hours: 4 });
    await emit(shop._id, { key: `SUPPORT_ACCESS:${String(d._id)}`, type: 'SUPPORT_ACCESS', priority: 'high', title: 'MedShop support asks to look at your shop for 4 h', body: 'Approve or deny in Settings → Support access.', route: '/settings/support', roles: ['owner'] });
  };

  const helper = http.createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/otp' && req.url !== '/admin' && req.url !== '/support')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { email: string; code: string; shopName?: string };
      (req.url === '/admin' ? seedAdmin(body) : req.url === '/support' ? seedSupport(body) : h.seedOtp(body.email, body.code)).then(
        () => res.writeHead(204).end(),
        (err: unknown) => res.writeHead(500).end(String(err)),
      );
    });
  });
  helper.listen(HELPER_PORT, '127.0.0.1');
  process.stdout.write(`e2e API on :${API_PORT}, OTP helper on 127.0.0.1:${HELPER_PORT}\n`);

  const stop = () => {
    helper.close();
    void h.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(crash);
