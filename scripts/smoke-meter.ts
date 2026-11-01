// D109 checks: AI is paid by what it really used. Tokens become ₹0.10 each once (bought tokens keep their value, free
// ones go), each shop gets up to ₹10 of real AI cost free an IST month (used first, reset — never added up), and a job
// holds its worst case before it runs and takes its real cost × the margin after.
import { startFakeClaude } from './lib/fake-claude';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';
import { MA_AI } from './lib/ma-bill';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error as { details?: { reason?: string } } | undefined)?.details?.reason;
const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);
const LEGACY = [{ code: 'c25', name: 'Starter', coins: 25, price: 29_900 }, { code: 'c100', name: 'Shop', coins: 100, price: 99_900 }, { code: 'c500', name: 'Busy shop', coins: 500, price: 449_900 }];

async function main() {
  const fake = await startFakeClaude();
  process.env.AI_BASE_URL = fake.url;
  const h = await startHarness({ freeMonthPaise: 1000 });
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { AiSettingsModel, CoinEntryModel, CoinWalletModel } = await import('../src/modules/ai/ai.model.js');
  const { moveCoins } = await import('../src/modules/ai/coins.js');
  const { tokensToTenPaise } = await import('../src/modules/ai/meter.js');
  const { roomOf } = await import('../src/modules/ai/guard.js');
  const { aiSettings } = await import('../src/modules/ai/ai-settings.js');
  const { inTransaction } = await import('../src/core/transaction.js');
  const { istMonth } = await import('../src/utils/date.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@meter1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const shop = new Types.ObjectId(shopId);
  const ma = data<{ id: string }>(await owner.post('/suppliers', { name: 'M.A. Pharma', contactPerson: '', phone: '98360 90271', email: '', gstin: '', drugLicense: '', creditDays: 15, address: 'Hridaypur' })).id;
  const other = await h.signIn('mina@meter2.test');
  const otherShop = new Types.ObjectId(data<{ id: string }>(await other.post('/shops', shopBody('Mina Medical'))).id);
  const give = (s: InstanceType<typeof Types.ObjectId>, kind: 'purchase' | 'welcome' | 'grant', n: number) => inTransaction((session) => moveCoins(s, kind, n, `test ${kind}`, 'smoke', 'smoke', session));
  const wallet = async (s = shop) => CoinWalletModel.findOne({ shopId: s }).lean();

  section('1. Once: tokens become ₹0.10 each — bought tokens keep their value, free ones go');
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { packs: LEGACY, welcomeCoins: 100 } });
  await give(shop, 'purchase', 25);
  await give(shop, 'welcome', 10);
  await give(otherShop, 'welcome', 100);
  const moved = await tokensToTenPaise();
  const s1 = await aiSettings();
  check('packs: price ÷ 10 paise — ₹299 = 2,990, ₹999 = 9,990, ₹4,499 = 44,990 tokens; no more welcome tokens', s1.packs.map((p) => p.coins).join() === '2990,9990,44990' && s1.welcomeCoins === 0 && s1.oldCoinPaise === 762 && s1.tokensAt !== null, JSON.stringify(s1.packs));
  check('a shop that bought 25 (and was given 10): its 25 bought × ₹7.62 ÷ ₹0.08 = 2,381 new tokens; the 10 free go', moved === 2 && (await wallet())?.balance === 2381 && (await wallet())?.oldFreeGone === 10, JSON.stringify(await wallet()));
  check('…one “convert” line in its ledger saying so', Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'convert', coins: 2381 - 35, balance: 2381, text: { $regex: '25 bought tokens = 2381 new tokens' } })));
  check('a shop with only free tokens (100): 0 now, told the monthly free AI replaces them', (await wallet(otherShop))?.balance === 0 && Boolean(await CoinEntryModel.exists({ shopId: otherShop, kind: 'convert', coins: -100, balance: 0 })));
  check('…the guard no longer counts the 100 it no longer has', (await roomOf(otherShop, s1)).giftedPaise === 0);
  check('runs once: a second time changes nothing', (await tokensToTenPaise()) === 0 && (await wallet())?.balance === 2381);

  section('2. ₹10 of real AI cost free every month, used first');
  await AdminUserModel.create({ email: 'root@meter.test', name: 'Root', role: 'super' });
  const root = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('root@meter.test', '135790', 'admin');
  const secret = data<{ secret?: string }>(await root.post('/admin/auth/verify', { email: 'root@meter.test', otp: '135790' })).secret ?? '';
  await root.post('/admin/auth/totp', { code: totpAt(secret, Math.floor(Date.now() / 30_000)) });
  await root.put('/admin/ai/key', { apiKey: fake.key, reason: 'new key from Anthropic console' });
  const on = await root.put('/admin/ai/settings', { settings: { enabled: true, model: 'claude-sonnet-5-5', effort: 'low', coinsPerPage: 1, maxPages: 5, welcomeCoins: 0, targetMargin: 1.5, usdInr: 88, packs: s1.packs }, reason: 'AI reading on' });
  check('reading on (Sonnet: a page’s worst ₹7.92)', on.status === 200, code(on));
  // Start this part at 0 tokens without a take-back (a take-back rightly lowers what the guard lets the shop spend).
  await CoinWalletModel.updateOne({ shopId: shop }, { $set: { balance: 0 } });
  fake.answer = { bill: MA_AI, input: 3200, output: 2400 };
  const read = () => owner.post('/purchases/import/ai', { supplierId: ma, fileName: 'bill.jpg', data: `data:image/jpeg;base64,${PHOTO.toString('base64')}` });
  type Offer = { coinsPerPage: number; mostPerPage: number; free: { leftPaise: number; monthPaise: number; resetsOn: string }; balance: number };
  const offer = async () => data<Offer>(await owner.get('/ai/offer'));
  const o0 = await offer();
  check('0 tokens, ₹10 free: a page needs 0 tokens (its worst ₹7.92 fits in the free AI), 149 without it', o0.coinsPerPage === 0 && o0.mostPerPage === 149 && o0.free.leftPaise === 1000 && o0.free.monthPaise === 1000 && o0.balance === 0, JSON.stringify(o0));
  const r1 = await read();
  const a1 = data<{ ai: { coins: number; freePaise: number; balance: number } }>(r1).ai;
  check('a read with 0 tokens → done on the free AI: its ₹2.68 from the ₹10, 0 tokens', r1.status === 200 && a1.coins === 0 && a1.freePaise === 268 && a1.balance === 0, code(r1));
  const w1 = await wallet();
  check('…₹2.68 of this month used, the month noted; one ledger line, 0 tokens, saying the free AI paid', w1?.freeUsedPaise === 268 && w1.freeTotalPaise === 268 && w1.freeMonth === istMonth(new Date()) && w1.held === 0 && Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'read', coins: 0, text: { $regex: '₹2.68 of this month’s free AI' } })));
  const o1 = await offer();
  check('₹7.32 free left: the next page needs ⌈(₹7.92 − ₹7.32) × 1.5 ÷ ₹0.08⌉ = 12 tokens', o1.free.leftPaise === 732 && o1.coinsPerPage === 12, JSON.stringify(o1));
  const r2 = await read();
  check('with 0 tokens → 409 “buy tokens”, nothing used', r2.status === 409 && reason(r2) === 'NOT_ENOUGH_COINS' && (await wallet())?.freeUsedPaise === 268, code(r2));
  await give(shop, 'grant', 12);
  const r3 = await read();
  const a3 = data<{ ai: { coins: number; freePaise: number; balance: number } }>(r3).ai;
  check('given 12 → read: ₹7.32 free + 12 tokens held, its ₹2.68 came from the free AI, the 12 back', r3.status === 200 && a3.coins === 0 && a3.freePaise === 268 && a3.balance === 12 && (await wallet())?.freeUsedPaise === 536 && (await wallet())?.held === 0, code(r3));
  const m = data<{ on: boolean; balance: number; free: { usedPaise: number; leftPaise: number; monthPaise: number } }>(await owner.get('/ai/meter'));
  check('the header: 12 tokens, free ₹5.36 of ₹10 used, ₹4.64 left', m.on && m.balance === 12 && m.free.usedPaise === 536 && m.free.leftPaise === 464 && m.free.monthPaise === 1000, JSON.stringify(m));
  check('the guard counts the free AI used: given ₹0.96 + free ₹5.36 ≥ the AI cost ₹5.36', (await roomOf(shop, await aiSettings())).leftPaise >= 0 && (await roomOf(shop, await aiSettings())).giftedPaise === 12 * 8 + 536);

  section('3. A new month starts the free AI again — never added up');
  await CoinWalletModel.updateOne({ shopId: shop }, { $set: { freeMonth: '2026-01' } });
  const o2 = await offer();
  check('last month’s ₹5.36 used doesn’t count: ₹10 free again (not ₹14.64)', o2.free.leftPaise === 1000 && o2.coinsPerPage === 0, JSON.stringify(o2));
  const r4 = await read();
  check('the month’s first read starts from 0: ₹2.68 used this month', r4.status === 200 && (await wallet())?.freeUsedPaise === 268 && (await wallet())?.freeMonth === istMonth(new Date()) && (await wallet())?.freeTotalPaise === 804, code(r4));

  await fake.close();
  await h.close();
  finish();
}

main().catch(crash);
