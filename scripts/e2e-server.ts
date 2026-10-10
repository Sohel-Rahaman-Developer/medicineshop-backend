// API for the frontend Playwright suite: real app on :5000 + in-memory DB; a localhost-only helper on :5099 seeds OTPs.
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeClaude } from './lib/fake-claude';
import { crash, startHarness } from './lib/harness';
import { MA_AI } from './lib/ma-bill';

const API_PORT = Number(process.env.E2E_API_PORT ?? 5000);
const HELPER_PORT = Number(process.env.E2E_HELPER_PORT ?? 5099);

async function main() {
  process.env.PORT = String(API_PORT);
  // Every Playwright project signs in from the same IP; the per-email limits stay real.
  process.env.RATE_OTP_REQUEST_PER_IP ??= '1000';
  // D78: AI reading goes to a local stand-in for Anthropic that copies the M.A. Pharma bill.
  const claude = await startFakeClaude();
  claude.answer = { bill: MA_AI };
  claude.chat = { say: 'Dolo 650 has paracetamol — for fever and pain. For a dose, ask a doctor.' };
  process.env.AI_BASE_URL = claude.url;
  const h = await startHarness({ port: API_PORT, dbPath: join(tmpdir(), `medshop-e2e-db-${String(API_PORT)}`) });

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
  /** Shop suite: MedShop support asks to look at the named shop; console suite: its own admin, already allowed. */
  const seedSupport = async (b: { shopName?: string; adminEmail?: string; approve?: boolean }) => {
    const shop = await ShopModel.findOne({ name: b.shopName }).lean();
    if (!shop) throw new Error('shop not found');
    const admin = b.adminEmail ? await AdminUserModel.findOne({ email: b.adminEmail.toLowerCase() }) : await AdminUserModel.findOneAndUpdate({ email: 'support@medshop.test' }, { $setOnInsert: { email: 'support@medshop.test', name: 'Sara (support)', role: 'support' } }, { upsert: true, returnDocument: 'after' });
    if (!admin) throw new Error('admin not found');
    const now = new Date();
    const d = await SupportAccessModel.create({ shopId: shop._id, adminUserId: admin._id, agentName: admin.name, reason: 'Owner asked about a bill total', hours: 4, ...(b.approve ? { status: 'approved', decidedBy: 'Shop Owner', decidedAt: now, startedAt: now, endsAt: new Date(now.getTime() + 4 * 3_600_000) } : {}) });
    if (b.approve) return;
    await emit(shop._id, { key: `SUPPORT_ACCESS:${String(d._id)}`, type: 'SUPPORT_ACCESS', priority: 'high', title: 'MedShop support asks to look at your shop for 4 h', body: 'Approve or deny in Settings → Support access.', route: '/settings/support', roles: ['owner'] });
  };

  const { SessionModel } = await import('../src/modules/auth/models/session.model.js');
  const { UserModel } = await import('../src/modules/user/user.model.js');
  /** PIN suite (D60): pretend this person's devices have been idle for so many minutes. */
  const seedIdle = async (b: { email?: string; minutes?: number }) => {
    const u = await UserModel.findOne({ email: (b.email ?? '').toLowerCase() }).lean();
    if (!u) throw new Error('user not found');
    await SessionModel.updateMany({ userId: u._id, revokedAt: null }, { $set: { lastUsedAt: new Date(Date.now() - (b.minutes ?? 0) * 60_000) } });
  };

  const { CHAT_DEFAULTS, saveChatSettings, setApiKey, saveAiSettings } = await import('../src/modules/ai/ai-settings.js');
  const { moveCoins } = await import('../src/modules/ai/coins.js');
  const { inTransaction } = await import('../src/core/transaction.js');
  const { DEFAULT_PACKS } = await import('../src/modules/ai/ai.model.js');
  /** AI suite (D78): AI reading on with the stand-in's key, and coins for the named shop. */
  const seedAi = async (b: { shopName?: string; coins?: number }) => {
    await setApiKey(claude.key, 'E2E');
    await saveAiSettings({ enabled: true, model: 'claude-sonnet-5-5', effort: 'low', coinsPerPage: 1, maxPages: 10, usdInr: 88, packs: DEFAULT_PACKS }, 'E2E');
    if (!b.shopName || !b.coins) return;
    const shop = await ShopModel.findOne({ name: b.shopName }).lean();
    if (!shop) throw new Error('shop not found');
    await inTransaction((session) => moveCoins(shop._id, 'grant', b.coins ?? 0, 'E2E coins', 'MedShop · E2E', 'e2e', session));
  };

  /** Chat suite (D81): AI questions on with the stand-in's key (every project, any order). */
  const seedChat = async () => {
    await setApiKey(claude.key, 'E2E');
    await saveChatSettings({ ...CHAT_DEFAULTS, enabled: true }, 'E2E');
  };

  const helper = http.createServer((req, res) => {
    if (req.method !== 'POST' || !['/otp', '/admin', '/support', '/idle', '/ai', '/chat'].includes(req.url ?? '')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { email: string; code: string; shopName?: string; minutes?: number; coins?: number };
      (req.url === '/chat' ? seedChat() : req.url === '/ai' ? seedAi(body) : req.url === '/admin' ? seedAdmin(body) : req.url === '/support' ? seedSupport(body) : req.url === '/idle' ? seedIdle(body) : h.seedOtp(body.email, body.code)).then(
        () => res.writeHead(204).end(),
        (err: unknown) => res.writeHead(500).end(String(err)),
      );
    });
  });
  helper.listen(HELPER_PORT, '127.0.0.1');
  process.stdout.write(`e2e API on :${API_PORT}, OTP helper on 127.0.0.1:${HELPER_PORT}\n`);

  const stop = () => {
    helper.close();
    void claude.close();
    void h.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(crash);
